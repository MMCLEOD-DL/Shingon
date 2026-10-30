"""The knowledge service core (K2): tenants, collections and principals; repeat-safe sync with versions,
deletions and permission changes; keyword search with the permission filter inside the candidate query; the
original-file rule; import status and audit. Implements the search half of retrieval-contract.md in keyword
mode. There is no HTTP layer yet (K6) and no vectors yet (K3).
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from .db import Db, migrate
from .parsers import ImportProblem, parse

INSTRUCTION_LIKE = re.compile(
    r'ignore (all |any )?(previous|prior|above) instructions|you are now|system prompt|disregard (the|your)'
    r'|\bapprove (this|the) (release|change|plan)\b|curl [^\s|]+ *\| *(ba)?sh', re.I)
CONTROL = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')
# Evidence thresholds on the normalised keyword score. Provisional: K4 replaces them with a calibrated reranker.
STRONG, WEAK = 0.25, 0.08
# Operator-marked superseded sources are still returned (flagged) but ranked below current ones (evaluation.md).
SUPERSEDED_WEIGHT = 0.5
# GET /passages/:chunkId widens a hit by at most this many passages either side.
MAX_NEIGHBOURS = 2


class ScopeError(PermissionError):
    """A request asked for more than its credential allows. Refused, never silently narrowed."""


class NotFound(LookupError):
    """Missing and hidden look the same to the caller."""


@dataclass(frozen=True)
class Credential:
    """What the service knows about a caller. It comes from a trusted credential, never from the request body."""
    name: str
    tenant: str
    principal: str | None  # None for a project token (Conductor)
    collections: tuple[str, ...] = field(default_factory=tuple)  # empty: every collection of the tenant


class KnowledgeService:
    def __init__(self, db: Db, originals: Path):
        self.db = db
        self.originals = originals  # stored originals, outside the index

    # ---------- configuration ----------

    def setup(self, config: dict) -> None:
        """Applies the schema and declares tenants, principals, groups and collections (idempotent)."""
        migrate(self.db)
        with self.db.transaction():
            for t, spec in config.get('tenants', {}).items():
                self.db.execute('INSERT INTO tenants (id) VALUES (%s) ON CONFLICT DO NOTHING', (t,))
                for p in spec.get('principals', {}):
                    self.db.execute('INSERT INTO principals VALUES (%s, %s) ON CONFLICT DO NOTHING', (t, p))
                for g, members in spec.get('groups', {}).items():
                    self._replace_group(t, g, members)
            for c, spec in config.get('collections', {}).items():
                self.db.execute(
                    'INSERT INTO collections VALUES (%s, %s, %s, %s::text[]) ON CONFLICT (id) DO UPDATE SET destinations = EXCLUDED.destinations '
                    'WHERE collections.tenant_id = EXCLUDED.tenant_id AND collections.kind = EXCLUDED.kind',
                    (c, spec['tenant'], spec['kind'], spec['destinations']))
                row = self.db.execute('SELECT tenant_id, kind FROM collections WHERE id = %s', (c,)).fetchone()
                if tuple(row) != (spec['tenant'], spec['kind']):
                    raise ValueError(f'Collection {c} already belongs to another tenant or kind; it is never moved.')

    def issue_project_token(self, name: str, collections: list[str]) -> Credential:
        """A Conductor token: reference collections of one tenant only (retrieval-contract.md §7)."""
        rows = self.db.execute('SELECT id, tenant_id, kind FROM collections WHERE id = ANY(%s::text[])', (list(collections),)).fetchall()
        self.db.commit()
        if not collections or len(rows) != len(set(collections)) or any(k != 'reference' for _i, _t, k in rows) \
                or len({t for _i, t, _k in rows}) != 1:
            raise ScopeError('A project token may cover reference collections of one tenant only.')
        return Credential(name, rows[0][1], None, tuple(sorted(set(collections))))

    def set_group_members(self, tenant: str, group: str, members: list[str]) -> None:
        """A permission change from the directory: effective on the next search. It changes the view revision of
        exactly the callers whose view it changes."""
        with self.db.transaction():
            self._replace_group(tenant, group, members)
            self._bump(tenant)

    def _replace_group(self, tenant: str, group: str, members: list[str]) -> None:
        self.db.execute('DELETE FROM group_members WHERE tenant_id = %s AND group_id = %s', (tenant, group))
        for m in members:
            self.db.execute('INSERT INTO group_members VALUES (%s, %s, %s)', (tenant, group, m))

    # ---------- sync ----------

    def sync(self, run_id: str, root: Path, sources: list[dict], files: dict[str, Path] | None = None) -> dict:
        """Brings the index in line with a source listing. Repeat-safe: an unchanged file (same sha256) is skipped,
        though its ACL and supersession are still applied; a changed file becomes a new version whose chunks replace
        the old ones; a source no longer listed in its collection is deleted with its chunks and stored original.
        Every outcome is recorded in import_events. One source's failure never stops the others."""
        files = files or {}
        counts = {'added': 0, 'updated': 0, 'unchanged': 0, 'deleted': 0, 'failed': 0, 'acl': 0}
        listed: dict[str, set[str]] = {}
        for s in sources:
            listed.setdefault(s['collection'], set()).add(s['key'])
            with self.db.transaction():
                outcome = self._sync_one(run_id, s, files.get(s['key'], root / s['key']))
            counts[outcome] += 1
        for coll, keys in listed.items():
            gone = self.db.execute("SELECT id, key FROM sources WHERE collection_id = %s AND status <> 'deleted' AND NOT (key = ANY(%s::text[]))",
                                   (coll, list(keys))).fetchall()
            for sid, key in gone:
                with self.db.transaction():
                    self._delete(run_id, coll, sid, key)
                counts['deleted'] += 1
        self.db.commit()
        return counts

    def _sync_one(self, run_id: str, s: dict, path: Path) -> str:
        coll = s['collection']
        row = self.db.execute('SELECT tenant_id FROM collections WHERE id = %s', (coll,)).fetchone()
        if row is None:
            raise ValueError(f'Unknown collection {coll}: declare it in setup() first.')
        tenant = row[0]
        acl = s.get('acl') or {}
        acl_all = not acl
        acl_groups, acl_principals = list(acl.get('groups', [])), list(acl.get('principals', []))
        superseded_by = s.get('supersededBy')
        existing = self.db.execute('SELECT id, current_version, status FROM sources WHERE collection_id = %s AND key = %s',
                                   (coll, s['key'])).fetchone()
        try:
            data = path.read_bytes()
        except OSError:
            return self._fail(run_id, coll, s['key'], tenant, existing, acl_all, acl_groups, acl_principals,
                              'The file could not be read from the source folder. Check it still exists and is readable.')
        sha = hashlib.sha256(data).hexdigest()
        if existing:
            sid, cur, status = existing
            same = cur is not None and self.db.execute('SELECT sha256 FROM versions WHERE source_id = %s AND n = %s',
                                                       (sid, cur)).fetchone()[0] == sha
            if same and status == 'active':
                changed = self.db.execute(
                    'UPDATE sources SET acl_all = %s, acl_groups = %s::text[], acl_principals = %s::text[], superseded_by = %s WHERE id = %s '
                    'AND (acl_all, acl_groups, acl_principals, superseded_by) IS DISTINCT FROM (%s, %s::text[], %s::text[], %s::text)',
                    (acl_all, acl_groups, acl_principals, superseded_by, sid, acl_all, acl_groups, acl_principals, superseded_by)).rowcount
                if changed:
                    self.db.execute('UPDATE chunks SET acl_all = %s, acl_groups = %s::text[], acl_principals = %s::text[] WHERE source_id = %s',
                                    (acl_all, acl_groups, acl_principals, sid))
                    self._bump(tenant)
                    self._event(run_id, coll, s['key'], 'acl', 'Permissions or supersession updated.')
                    return 'acl'
                self._event(run_id, coll, s['key'], 'unchanged', 'No change.')
                return 'unchanged'
        try:
            title, chunks = parse(path)
        except ImportProblem as e:
            return self._fail(run_id, coll, s['key'], tenant, existing, acl_all, acl_groups, acl_principals, str(e))
        if existing:
            sid, cur = existing[0], existing[1] or 0
            n = cur + 1
            self.db.execute('DELETE FROM chunks WHERE source_id = %s', (sid,))
            self.db.execute("UPDATE sources SET status = 'active', current_version = %s, superseded_by = %s, acl_all = %s, "
                            "acl_groups = %s::text[], acl_principals = %s::text[] WHERE id = %s",
                            (n, superseded_by, acl_all, acl_groups, acl_principals, sid))
            outcome = 'updated' if existing[1] else 'added'
        else:
            n = 1
            sid = self.db.execute("INSERT INTO sources (collection_id, key, status, current_version, superseded_by, acl_all, "
                                  "acl_groups, acl_principals) VALUES (%s, %s, 'active', 1, %s, %s, %s::text[], %s::text[]) RETURNING id",
                                  (coll, s['key'], superseded_by, acl_all, acl_groups, acl_principals)).fetchone()[0]
            outcome = 'added'
        original = self.originals / coll / str(sid) / f'v{n}{path.suffix.lower()}'
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(data)
        self.db.execute('INSERT INTO versions (source_id, n, sha256, original_path) VALUES (%s, %s, %s, %s)',
                        (sid, n, sha, str(original)))
        for c in chunks:
            self.db.execute('INSERT INTO chunks (source_id, version, tenant_id, collection_id, title, text, locator, acl_all, '
                            'acl_groups, acl_principals, instruction_like) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s::text[],%s::text[],%s)',
                            (sid, n, tenant, coll, title, c.text, json.dumps(c.locator), acl_all, acl_groups,
                             acl_principals, bool(INSTRUCTION_LIKE.search(c.text))))
        self._bump(tenant)
        self._event(run_id, coll, s['key'], outcome, f'Version {n}: {len(chunks)} passages.')
        return outcome

    def _fail(self, run_id, coll, key, tenant, existing, acl_all, acl_groups, acl_principals, message) -> str:
        if existing:  # nothing searchable stays from a source that now fails
            self.db.execute('DELETE FROM chunks WHERE source_id = %s', (existing[0],))
            self.db.execute("UPDATE sources SET status = 'failed' WHERE id = %s", (existing[0],))
            self._bump(tenant)
        else:
            self.db.execute("INSERT INTO sources (collection_id, key, status, acl_all, acl_groups, acl_principals) "
                            "VALUES (%s, %s, 'failed', %s, %s::text[], %s::text[])", (coll, key, acl_all, acl_groups, acl_principals))
        self._event(run_id, coll, key, 'failed', message)
        return 'failed'

    def _delete(self, run_id: str, coll: str, sid: int, key: str) -> None:
        tenant = self.db.execute('SELECT tenant_id FROM collections WHERE id = %s', (coll,)).fetchone()[0]
        self.db.execute('DELETE FROM chunks WHERE source_id = %s', (sid,))
        self.db.execute("UPDATE sources SET status = 'deleted' WHERE id = %s", (sid,))
        self.db.execute('UPDATE versions SET original_path = NULL WHERE source_id = %s', (sid,))
        shutil.rmtree(self.originals / coll / str(sid), ignore_errors=True)  # retention 0 days for now
        self._bump(tenant)
        self._event(run_id, coll, key, 'deleted', 'Removed at the source: passages and stored original deleted.')

    def _bump(self, tenant: str) -> None:
        self.db.execute('UPDATE tenants SET index_generation = index_generation + 1 WHERE id = %s', (tenant,))

    def _event(self, run_id, coll, key, outcome, message) -> None:
        self.db.execute('INSERT INTO import_events (run_id, collection_id, key, outcome, message) VALUES (%s,%s,%s,%s,%s)',
                        (run_id, coll, key, outcome, message))

    def import_status(self, run_id: str) -> list[dict]:
        rows = self.db.execute('SELECT collection_id, key, outcome, message FROM import_events WHERE run_id = %s ORDER BY id',
                               (run_id,)).fetchall()
        self.db.commit()
        return [{'collection': c, 'key': k, 'outcome': o, 'message': m} for c, k, o, m in rows]

    # ---------- read side ----------

    def _scope(self, cred: Credential) -> tuple[list[str], list[str]]:
        allowed = [r[0] for r in self.db.execute('SELECT id FROM collections WHERE tenant_id = %s ORDER BY id', (cred.tenant,)).fetchall()]
        if cred.collections:
            allowed = [c for c in allowed if c in cred.collections]
        groups = [] if cred.principal is None else [r[0] for r in self.db.execute(
            'SELECT group_id FROM group_members WHERE tenant_id = %s AND principal_id = %s', (cred.tenant, cred.principal)).fetchall()]
        return allowed, groups

    def search(self, cred: Credential, query: str, *, limit: int = 8, collections: list[str] | None = None,
               superseded_weight: float = SUPERSEDED_WEIGHT) -> dict:
        if not isinstance(query, str) or not 1 <= len(query) <= 1000 or not 1 <= limit <= 20:
            raise ValueError('bad-request')
        allowed, groups = self._scope(cred)
        if collections is not None:
            if any(c not in allowed for c in collections):
                raise ScopeError('scope')
            allowed = list(collections)
        started = time.perf_counter()
        # OR over the query's lexemes (plainto_tsquery ANDs them, which drops natural questions), cover-density
        # ranking normalised to 0..1. The ACL predicate sits in the same WHERE as the text match.
        rows = self.db.execute("""
            WITH q AS (SELECT CASE WHEN plainto_tsquery('english', %(q)s)::text = '' THEN NULL
                         ELSE replace(plainto_tsquery('english', %(q)s)::text, '&', '|')::tsquery END AS tsq)
            SELECT c.public_id, c.source_id, c.version, c.collection_id, c.title, c.text, c.locator, c.instruction_like,
                   s.key, succ.key AS superseded_by_visible,
                   ts_rank_cd(c.tsv, q.tsq, 32) * CASE WHEN s.superseded_by IS NULL THEN 1 ELSE %(sw)s::real END AS score,
                   to_char(v.ingested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            FROM chunks c JOIN sources s ON s.id = c.source_id JOIN versions v ON v.source_id = c.source_id AND v.n = c.version
            -- A reference to another document is shown only when the caller could open that document itself (Codex
            -- review KB-R3): same collection, active, and admitted by its own ACL. Demotion still uses the stored link.
            LEFT JOIN LATERAL (
              SELECT t.key FROM sources t
              WHERE t.collection_id = s.collection_id AND t.key = s.superseded_by AND t.status = 'active'
                AND (t.acl_all OR t.acl_groups && %(groups)s::text[] OR %(principal)s = ANY(t.acl_principals))
            ) succ ON true, q
            WHERE q.tsq IS NOT NULL AND c.tsv @@ q.tsq
              AND c.tenant_id = %(tenant)s AND c.collection_id = ANY(%(allowed)s::text[]) AND s.status = 'active'
              AND (c.acl_all OR c.acl_groups && %(groups)s::text[] OR %(principal)s = ANY(c.acl_principals))
            ORDER BY score DESC, c.id LIMIT %(limit)s""",
            {'q': query, 'tenant': cred.tenant, 'allowed': allowed, 'groups': groups,
             'principal': cred.principal or '', 'limit': limit, 'sw': superseded_weight}).fetchall()
        ms = (time.perf_counter() - started) * 1000
        results = [{
            'chunkId': r[0], 'documentId': r[8], 'versionId': r[2], 'collectionId': r[3], 'title': r[4],
            'excerpt': CONTROL.sub('', r[5])[:1200], 'locator': r[6],
            'scores': {'rank': i + 1, 'keyword': round(float(r[10]), 4)}, 'ingestedAt': r[11],
            'flags': {'supersededBy': r[9], 'instructionLike': r[7]},
        } for i, r in enumerate(rows)]
        top = results[0]['scores']['keyword'] if results else 0.0
        evidence = 'strong' if top >= STRONG else 'weak' if top >= WEAK else 'none'
        self.db.execute('INSERT INTO audit (credential, principal, collections, result_sources, query_sha256) VALUES (%s,%s,%s::text[],%s::bigint[],%s)',
                        (cred.name, cred.principal, allowed, [r[1] for r in rows], hashlib.sha256(query.encode()).hexdigest()))
        revision = self.view_revision(cred)
        self.db.commit()
        return {'viewRevision': revision, 'evidence': evidence, 'results': results, 'ms': ms}

    def view_revision(self, cred: Credential) -> str:
        """A digest of everything this credential can see, for cache invalidation (Codex review decision 1). It changes
        when a visible document is added, replaced, removed, re-permissioned out of view or marked superseded, when a
        replacement becomes visible, or when a visible collection's destinations change. A change to a document the
        caller cannot see leaves it as it was, so it reveals nothing the caller could not already list. The tenant's
        internal index_generation counter never leaves the service."""
        allowed, groups = self._scope(cred)
        acl = '(t.acl_all OR t.acl_groups && %(groups)s::text[] OR %(principal)s = ANY(t.acl_principals))'
        return self.db.execute(f"""
            SELECT encode(sha256(convert_to(coalesce(string_agg(item, E'\\n' ORDER BY item), ''), 'UTF8')), 'hex') FROM (
              SELECT jsonb_build_array('collection', c.id, c.destinations)::text AS item
              FROM collections c WHERE c.id = ANY(%(allowed)s::text[])
              UNION ALL
              SELECT jsonb_build_array('document', t.collection_id, t.key, t.current_version, t.superseded_by IS NOT NULL, succ.key)::text
              FROM sources t
              LEFT JOIN LATERAL (
                SELECT u.key FROM sources u
                WHERE u.collection_id = t.collection_id AND u.key = t.superseded_by AND u.status = 'active'
                  AND (u.acl_all OR u.acl_groups && %(groups)s::text[] OR %(principal)s = ANY(u.acl_principals))
              ) succ ON true
              WHERE t.collection_id = ANY(%(allowed)s::text[]) AND t.status = 'active' AND {acl}
            ) view""", {'allowed': allowed, 'groups': groups, 'principal': cred.principal or ''}).fetchone()[0]

    def collections(self, cred: Credential) -> dict:
        """The collections this credential can search, each with what this caller can see of it: how many documents and
        when the newest of them was ingested. Nothing counts documents the caller cannot see (retrieval-contract.md §3)."""
        allowed, groups = self._scope(cred)
        rows = self.db.execute("""
            SELECT c.id, c.kind, c.destinations, count(t.id),
                   to_char(max(v.ingested_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            FROM collections c
            LEFT JOIN sources t ON t.collection_id = c.id AND t.status = 'active'
              AND (t.acl_all OR t.acl_groups && %(groups)s::text[] OR %(principal)s = ANY(t.acl_principals))
            LEFT JOIN versions v ON v.source_id = t.id AND v.n = t.current_version
            WHERE c.id = ANY(%(allowed)s::text[])
            GROUP BY c.id, c.kind, c.destinations ORDER BY c.id""",
            {'allowed': allowed, 'groups': groups, 'principal': cred.principal or ''}).fetchall()
        revision = self.view_revision(cred)
        self.db.commit()
        return {'viewRevision': revision, 'collections': [
            {'collectionId': r[0], 'kind': r[1], 'destinations': list(r[2]), 'documents': r[3], 'lastIngestedAt': r[4]}
            for r in rows]}

    def passage(self, cred: Credential, chunk_id: str, neighbours: int = 1) -> dict:
        """One passage and up to `neighbours` (0 to 2) passages either side of it in the same document version, in
        document order. The chunk is re-authorised like a search hit; a hidden or missing id is the same NotFound."""
        if isinstance(neighbours, bool) or not isinstance(neighbours, int) or not 0 <= neighbours <= MAX_NEIGHBOURS:
            raise ValueError('bad-request')
        if not isinstance(chunk_id, str):
            raise NotFound('not-found')
        allowed, groups = self._scope(cred)
        rows = self.db.execute("""
            WITH focus AS (
              SELECT c.id, c.source_id FROM chunks c JOIN sources s ON s.id = c.source_id
              WHERE c.public_id = %(chunk)s AND c.tenant_id = %(tenant)s AND c.collection_id = ANY(%(allowed)s::text[])
                AND s.status = 'active'
                AND (c.acl_all OR c.acl_groups && %(groups)s::text[] OR %(principal)s = ANY(c.acl_principals))),
            doc AS (
              SELECT c.id, c.public_id, c.collection_id, c.version, c.title, c.text, c.locator, c.instruction_like,
                     row_number() OVER (ORDER BY c.id) AS n
              FROM chunks c JOIN focus f ON c.source_id = f.source_id)
            SELECT d.public_id, d.collection_id, s.key, d.version, d.title, d.text, d.locator, d.instruction_like, d.id = f.id
            FROM doc d, focus f, sources s, doc fd
            WHERE s.id = f.source_id AND fd.id = f.id AND d.n BETWEEN fd.n - %(k)s AND fd.n + %(k)s
            ORDER BY d.n""",
            {'chunk': chunk_id, 'tenant': cred.tenant, 'allowed': allowed, 'groups': groups,
             'principal': cred.principal or '', 'k': neighbours}).fetchall()
        if rows:
            self.db.execute('INSERT INTO audit (credential, principal, collections, result_sources, query_sha256) '
                            "SELECT %s, %s, %s::text[], ARRAY[source_id], 'passage' FROM chunks WHERE public_id = %s",
                            (cred.name, cred.principal, allowed, chunk_id))
        revision = self.view_revision(cred)
        self.db.commit()
        if not rows:
            raise NotFound('not-found')
        return {'viewRevision': revision, 'collectionId': rows[0][1], 'documentId': rows[0][2], 'versionId': rows[0][3],
                'title': rows[0][4], 'passages': [
                    {'chunkId': r[0], 'text': CONTROL.sub('', r[5])[:1200], 'locator': r[6], 'instructionLike': r[7],
                     'focus': r[8]} for r in rows]}

    def health(self) -> dict:
        """Readiness only: the index answers. Raises if it does not (the caller's 503)."""
        self.db.execute('SELECT 1').fetchone()
        self.db.commit()
        return {'status': 'ok'}

    def original(self, cred: Credential, collection: str, key: str, version: int) -> Path:
        """The stored original of `version`, only while it is the current version, under the same permission rule as
        search. Any other version gets the same NotFound as a hidden or missing document; the latest bytes are never
        served in its place (retrieval-contract.md §3)."""
        if isinstance(version, bool) or not isinstance(version, int):
            raise NotFound('not-found')
        allowed, groups = self._scope(cred)
        row = self.db.execute("""
            SELECT v.original_path FROM sources s JOIN collections c ON c.id = s.collection_id
            JOIN versions v ON v.source_id = s.id AND v.n = s.current_version
            WHERE s.key = %s AND s.collection_id = %s AND s.current_version = %s AND c.tenant_id = %s
              AND s.collection_id = ANY(%s::text[]) AND s.status = 'active'
              AND (s.acl_all OR s.acl_groups && %s::text[] OR %s = ANY(s.acl_principals))""",
            (key, collection, version, cred.tenant, allowed, groups, cred.principal or '')).fetchone()
        if row:  # audited like a search: who fetched which original
            self.db.execute('INSERT INTO audit (credential, principal, collections, result_sources, query_sha256) '
                            "SELECT %s, %s, %s::text[], ARRAY[id], 'original' FROM sources WHERE collection_id = %s AND key = %s",
                            (cred.name, cred.principal, [collection], collection, key))
        self.db.commit()
        if not row or not row[0]:
            raise NotFound('not-found')
        return Path(row[0])
