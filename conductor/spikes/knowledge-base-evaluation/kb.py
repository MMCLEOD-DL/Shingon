"""A minimal knowledge service for the P06 evaluation: PostgreSQL metadata + chunks + full-text, permission filters
applied inside the candidate query, versioned sources, repeat-safe sync with deletions, and visible import errors.

It implements the search half of retrieval-contract.md (keyword mode). It is a spike: no HTTP layer, no embeddings
(see RESULT.md for why hybrid retrieval was not run here), and parsers are deliberately simple.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

import psycopg
from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader

SCHEMA = """
CREATE TABLE tenants (id text PRIMARY KEY, index_generation bigint NOT NULL DEFAULT 0);
CREATE TABLE principals (tenant_id text REFERENCES tenants, id text, PRIMARY KEY (tenant_id, id));
CREATE TABLE group_members (tenant_id text, group_id text, principal_id text, PRIMARY KEY (tenant_id, group_id, principal_id));
CREATE TABLE collections (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants,
  kind text NOT NULL CHECK (kind IN ('reference', 'client-runtime')), destinations text[] NOT NULL);
CREATE TABLE sources (id bigserial PRIMARY KEY, collection_id text NOT NULL REFERENCES collections, key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted', 'failed')), current_version int,
  superseded_by text, acl_all boolean NOT NULL, acl_groups text[] NOT NULL, acl_principals text[] NOT NULL,
  UNIQUE (collection_id, key));
CREATE TABLE versions (source_id bigint REFERENCES sources, n int, sha256 text NOT NULL, original_path text,
  ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (source_id, n));
-- Chunks carry the tenant, collection and ACL of their source, so the permission filter is part of the candidate
-- query itself. A source's ACL change rewrites its chunks' ACL columns in the same transaction.
CREATE TABLE chunks (id bigserial PRIMARY KEY, source_id bigint NOT NULL REFERENCES sources, version int NOT NULL,
  tenant_id text NOT NULL, collection_id text NOT NULL, title text NOT NULL, text text NOT NULL, locator jsonb NOT NULL,
  acl_all boolean NOT NULL, acl_groups text[] NOT NULL, acl_principals text[] NOT NULL, instruction_like boolean NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || text)) STORED);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);
CREATE INDEX chunks_scope ON chunks (tenant_id, collection_id);
CREATE TABLE import_events (id bigserial PRIMARY KEY, run_id text NOT NULL, collection_id text, key text NOT NULL,
  outcome text NOT NULL, message text NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit (id bigserial PRIMARY KEY, credential text NOT NULL, principal text, collections text[],
  result_sources bigint[], query_sha256 text NOT NULL, at timestamptz NOT NULL DEFAULT now());
"""

INSTRUCTION_LIKE = re.compile(
    r'ignore (all |any )?(previous|prior|above) instructions|you are now|system prompt|disregard (the|your)'
    r'|\bapprove (this|the) (release|change|plan)\b|curl [^\s|]+ *\| *(ba)?sh', re.I)
MAX_CHUNK = 1500


class ImportProblem(Exception):
    """A file that can't be indexed; the message is what the operator sees in the import status."""


@dataclass
class Chunk:
    text: str
    locator: dict


# ---------- parsers: each returns (title, chunks) with the finest locator the format allows ----------

def _split(text: str, locator: dict) -> list[Chunk]:
    out, buf = [], ''
    for para in text.split('\n'):
        if buf and len(buf) + len(para) > MAX_CHUNK:
            out.append(Chunk(buf.strip(), locator))
            buf = ''
        buf += para + '\n'
    if buf.strip():
        out.append(Chunk(buf.strip(), locator))
    return out


def parse_markdown(path: Path) -> tuple[str, list[Chunk]]:
    title, stack, chunks, body = path.stem, [], [], []

    def flush():
        if body and ''.join(body).strip():
            chunks.extend(_split('\n'.join(body), {'sectionPath': list(stack)}))
        body.clear()

    for line in path.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^(#{1,6})\s+(.*)', line)
        if m:
            flush()
            level, heading = len(m.group(1)), m.group(2).strip()
            if level == 1 and title == path.stem:
                title = heading
            del stack[level - 1:]
            stack.append(heading)
        else:
            body.append(line)
    flush()
    return title, chunks


def parse_docx(path: Path) -> tuple[str, list[Chunk]]:
    doc = Document(str(path))
    title, stack, chunks, body = path.stem, [], [], []

    def flush():
        if body:
            chunks.extend(_split('\n'.join(body), {'sectionPath': list(stack)}))
        body.clear()

    for p in doc.paragraphs:
        style = p.style.name if p.style is not None else ''
        m = re.match(r'Heading (\d)', style)
        if m and p.text.strip():
            flush()
            level = int(m.group(1))
            if level == 1 and title == path.stem:
                title = p.text.strip()
            del stack[level - 1:]
            stack.append(p.text.strip())
        elif p.text.strip():
            body.append(p.text.strip())
    flush()
    return title, chunks


def parse_pdf(path: Path) -> tuple[str, list[Chunk]]:
    try:
        reader = PdfReader(str(path))
    except Exception as e:  # noqa: BLE001 - any parser failure is an import problem, not a crash
        raise ImportProblem(f'The PDF could not be opened ({type(e).__name__}).') from e
    if reader.is_encrypted:
        raise ImportProblem('The PDF is password-protected. Remove the password at the source, then import it again.')
    chunks, title = [], path.stem
    for n, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or '').strip()
        if text:
            if n == 1:
                title = text.splitlines()[0].strip()
            chunks.extend(_split(text, {'page': n}))
    if not chunks:
        raise ImportProblem('The PDF has no text layer (a scan). No OCR engine is configured, so it was not indexed.')
    return title, chunks


def parse_xlsx(path: Path) -> tuple[str, list[Chunk]]:
    # data_only: the cached results of formulas, which exist only if a spreadsheet program last saved the file.
    wb = load_workbook(str(path), data_only=True, read_only=True)
    chunks, uncached = [], 0
    for ws in wb.worksheets:
        rows = list(ws.iter_rows())
        if not rows:
            continue
        header = [str(c.value) if c.value is not None else '' for c in rows[0]]
        for r in rows[1:]:
            cells = [(header[i] if i < len(header) else f'col{i + 1}', c) for i, c in enumerate(r)]
            if all(c.value is None for _h, c in cells):
                uncached += 1
                continue
            uncached += sum(1 for _h, c in cells if c.value is None)
            text = '; '.join(f'{h}: {c.value}' for h, c in cells if c.value is not None)
            first, last = r[0].coordinate, r[-1].coordinate
            chunks.append(Chunk(f'{ws.title} — {text}', {'sheet': ws.title, 'cellRange': f'{first}:{last}'}))
    if uncached:
        chunks.append(Chunk(f'[import note] {uncached} cells had formulas with no saved result and were not indexed.',
                            {'sheet': None, 'cellRange': None, 'importNote': True}))
    return path.stem, chunks


PARSERS = {'.md': parse_markdown, '.docx': parse_docx, '.pdf': parse_pdf, '.xlsx': parse_xlsx}


# ---------- the service ----------

@dataclass
class Credential:
    """What the service knows about a caller, from a trusted credential (never from the request body)."""
    name: str
    tenant: str
    principal: str | None  # None for a project token (Conductor)
    collections: list[str] = field(default_factory=list)  # empty: every collection of the tenant


class KB:
    def __init__(self, dsn: str, store: Path):
        self.db = psycopg.connect(dsn, autocommit=False)
        self.store = store  # where originals are kept, outside the index

    def setup(self, manifest: dict) -> None:
        with self.db.transaction():
            self.db.execute(SCHEMA)
            for t, spec in manifest['tenants'].items():
                self.db.execute('INSERT INTO tenants (id) VALUES (%s)', (t,))
                for p in spec['principals']:
                    self.db.execute('INSERT INTO principals VALUES (%s, %s)', (t, p))
                for g, members in spec['groups'].items():
                    for m in members:
                        self.db.execute('INSERT INTO group_members VALUES (%s, %s, %s)', (t, g, m))
            for c, spec in manifest['collections'].items():
                self.db.execute('INSERT INTO collections VALUES (%s, %s, %s, %s)',
                                (c, spec['tenant'], spec['kind'], spec['destinations']))

    def issue_project_token(self, name: str, collections: list[str]) -> Credential:
        """A Conductor token: reference collections of one tenant only (retrieval-contract.md §7)."""
        rows = self.db.execute('SELECT id, tenant_id, kind FROM collections WHERE id = ANY(%s)', (collections,)).fetchall()
        if len(rows) != len(collections) or any(k != 'reference' for _i, _t, k in rows) or len({t for _i, t, _k in rows}) != 1:
            raise PermissionError('A project token may cover reference collections of one tenant only.')
        return Credential(name, rows[0][1], None, collections)

    def set_group_members(self, tenant: str, group: str, members: list[str]) -> None:
        """A permission change from the source directory: takes effect on the next search, and bumps the generation."""
        with self.db.transaction():
            self.db.execute('DELETE FROM group_members WHERE tenant_id = %s AND group_id = %s', (tenant, group))
            for m in members:
                self.db.execute('INSERT INTO group_members VALUES (%s, %s, %s)', (tenant, group, m))
            self.db.execute('UPDATE tenants SET index_generation = index_generation + 1 WHERE id = %s', (tenant,))

    def sync(self, run_id: str, root: Path, sources: list[dict], files: dict[str, Path] | None = None) -> dict:
        """Brings the index in line with a source listing. Repeat-safe: unchanged files (same sha256) are skipped; a
        changed file becomes a new version whose chunks replace the old ones; a source no longer listed is deleted with
        its chunks and its stored original. Every outcome is recorded in import_events."""
        files = files or {}
        counts = {'added': 0, 'updated': 0, 'unchanged': 0, 'deleted': 0, 'failed': 0, 'acl': 0}
        listed: dict[str, set[str]] = {}
        for s in sources:
            listed.setdefault(s['collection'], set()).add(s['key'])
            path = files.get(s['key'], root / s['key'])
            outcome = self._sync_one(run_id, s, path)
            counts[outcome] += 1
        for coll, keys in listed.items():
            gone = self.db.execute("SELECT id, key FROM sources WHERE collection_id = %s AND status <> 'deleted' AND NOT (key = ANY(%s))",
                                   (coll, list(keys))).fetchall()
            for sid, key in gone:
                self._delete(run_id, coll, sid, key)
                counts['deleted'] += 1
        self.db.commit()
        return counts

    def _sync_one(self, run_id: str, s: dict, path: Path) -> str:
        coll = s['collection']
        tenant = self.db.execute('SELECT tenant_id FROM collections WHERE id = %s', (coll,)).fetchone()[0]
        acl = s.get('acl') or {}
        acl_all = not acl
        acl_groups, acl_principals = acl.get('groups', []), acl.get('principals', [])
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        row = self.db.execute('SELECT id, current_version, status FROM sources WHERE collection_id = %s AND key = %s',
                              (coll, s['key'])).fetchone()
        if row:
            sid, cur, status = row
            same = cur is not None and self.db.execute('SELECT sha256 FROM versions WHERE source_id = %s AND n = %s',
                                                       (sid, cur)).fetchone()[0] == sha
            if same and status == 'active':
                # Unchanged content; metadata (ACL, supersession) may still have changed at the source.
                changed = self.db.execute(
                    'UPDATE sources SET acl_all = %s, acl_groups = %s, acl_principals = %s, superseded_by = %s '
                    'WHERE id = %s AND (acl_all, acl_groups, acl_principals, superseded_by) IS DISTINCT FROM (%s, %s, %s, %s)',
                    (acl_all, acl_groups, acl_principals, s.get('supersededBy'), sid,
                     acl_all, acl_groups, acl_principals, s.get('supersededBy'))).rowcount
                if changed:
                    self.db.execute('UPDATE chunks SET acl_all = %s, acl_groups = %s, acl_principals = %s WHERE source_id = %s',
                                    (acl_all, acl_groups, acl_principals, sid))
                    self._bump(tenant)
                    self._event(run_id, coll, s['key'], 'acl', 'Permissions or supersession updated.')
                    return 'acl'
                self._event(run_id, coll, s['key'], 'unchanged', 'No change.')
                return 'unchanged'
        parser = PARSERS.get(path.suffix.lower())
        try:
            if parser is None:
                raise ImportProblem(f'Files of type "{path.suffix or "none"}" are not supported, so it was not indexed.')
            title, chunks = parser(path)
        except ImportProblem as e:
            if row:  # keep nothing searchable from a source that now fails to parse
                self.db.execute('DELETE FROM chunks WHERE source_id = %s', (row[0],))
                self.db.execute("UPDATE sources SET status = 'failed' WHERE id = %s", (row[0],))
                self._bump(tenant)
            else:
                self.db.execute("INSERT INTO sources (collection_id, key, status, acl_all, acl_groups, acl_principals) "
                                "VALUES (%s, %s, 'failed', %s, %s, %s)", (coll, s['key'], acl_all, acl_groups, acl_principals))
            self._event(run_id, coll, s['key'], 'failed', str(e))
            return 'failed'
        if row:
            sid, cur = row[0], row[1] or 0
            n = cur + 1
            self.db.execute('DELETE FROM chunks WHERE source_id = %s', (sid,))
            self.db.execute("UPDATE sources SET status = 'active', current_version = %s, superseded_by = %s, acl_all = %s, "
                            "acl_groups = %s, acl_principals = %s WHERE id = %s",
                            (n, s.get('supersededBy'), acl_all, acl_groups, acl_principals, sid))
            outcome = 'updated' if row[1] else 'added'
        else:
            n = 1
            sid = self.db.execute("INSERT INTO sources (collection_id, key, status, current_version, superseded_by, acl_all, "
                                  "acl_groups, acl_principals) VALUES (%s, %s, 'active', 1, %s, %s, %s, %s) RETURNING id",
                                  (coll, s['key'], s.get('supersededBy'), acl_all, acl_groups, acl_principals)).fetchone()[0]
            outcome = 'added'
        original = self.store / coll / str(sid) / f'v{n}{path.suffix}'
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(data)
        self.db.execute('INSERT INTO versions (source_id, n, sha256, original_path) VALUES (%s, %s, %s, %s)',
                        (sid, n, sha, str(original)))
        for c in chunks:
            self.db.execute('INSERT INTO chunks (source_id, version, tenant_id, collection_id, title, text, locator, acl_all, '
                            'acl_groups, acl_principals, instruction_like) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                            (sid, n, tenant, coll, title, c.text, json.dumps(c.locator), acl_all, acl_groups,
                             acl_principals, bool(INSTRUCTION_LIKE.search(c.text))))
        self._bump(tenant)
        self._event(run_id, coll, s['key'], outcome, f'Version {n}: {len(chunks)} passages.')
        return outcome

    def _delete(self, run_id: str, coll: str, sid: int, key: str) -> None:
        tenant = self.db.execute('SELECT tenant_id FROM collections WHERE id = %s', (coll,)).fetchone()[0]
        self.db.execute('DELETE FROM chunks WHERE source_id = %s', (sid,))
        self.db.execute("UPDATE sources SET status = 'deleted' WHERE id = %s", (sid,))
        shutil.rmtree(self.store / coll / str(sid), ignore_errors=True)  # retention 0 days for the spike
        self.db.execute('UPDATE versions SET original_path = NULL WHERE source_id = %s', (sid,))
        self._bump(tenant)
        self._event(run_id, coll, key, 'deleted', 'Removed at the source: passages and stored original deleted.')

    def _bump(self, tenant: str) -> None:
        self.db.execute('UPDATE tenants SET index_generation = index_generation + 1 WHERE id = %s', (tenant,))

    def _event(self, run_id, coll, key, outcome, message) -> None:
        self.db.execute('INSERT INTO import_events (run_id, collection_id, key, outcome, message) VALUES (%s,%s,%s,%s,%s)',
                        (run_id, coll, key, outcome, message))

    # ---------- search (retrieval-contract.md §3, keyword mode) ----------

    def search(self, cred: Credential, query: str, limit: int = 8, collections: list[str] | None = None,
               strong: float = 0.25, weak: float = 0.08, superseded_weight: float = 1.0) -> dict:
        """`superseded_weight` < 1 ranks a source the operator marked as replaced below current ones (it is still
        returned, flagged)."""
        if not 1 <= len(query) <= 1000 or not 1 <= limit <= 20:
            raise ValueError('bad-request')
        allowed = [r[0] for r in self.db.execute('SELECT id FROM collections WHERE tenant_id = %s', (cred.tenant,))]
        if cred.collections:
            allowed = [c for c in allowed if c in cred.collections]
        if collections is not None:
            if any(c not in allowed for c in collections):
                raise PermissionError('scope')  # a narrower request is fine; a wider one is refused, never dropped
            allowed = collections
        groups = [] if cred.principal is None else [r[0] for r in self.db.execute(
            'SELECT group_id FROM group_members WHERE tenant_id = %s AND principal_id = %s', (cred.tenant, cred.principal))]
        started = time.perf_counter()
        # OR over the query's lexemes (plainto_tsquery ANDs them, which drops natural questions), ranked by cover
        # density normalised to 0..1. The ACL predicate is in the same WHERE as the match: unauthorised chunks are
        # never ranked, counted or excerpted.
        rows = self.db.execute("""
            WITH q AS (SELECT CASE WHEN plainto_tsquery('english', %(q)s)::text = '' THEN NULL
                         ELSE replace(plainto_tsquery('english', %(q)s)::text, '&', '|')::tsquery END AS tsq)
            SELECT c.id, c.source_id, c.version, c.collection_id, c.title, c.text, c.locator, c.instruction_like,
                   s.key, s.superseded_by,
                   ts_rank_cd(c.tsv, q.tsq, 32) * CASE WHEN s.superseded_by IS NULL THEN 1 ELSE %(sw)s END AS score
            FROM chunks c JOIN sources s ON s.id = c.source_id, q
            WHERE q.tsq IS NOT NULL AND c.tsv @@ q.tsq
              AND c.tenant_id = %(tenant)s AND c.collection_id = ANY(%(allowed)s) AND s.status = 'active'
              AND (c.acl_all OR c.acl_groups && %(groups)s::text[] OR %(principal)s = ANY(c.acl_principals))
            ORDER BY score DESC, c.id LIMIT %(limit)s""",
            {'q': query, 'tenant': cred.tenant, 'allowed': allowed, 'groups': groups,
             'principal': cred.principal or '', 'limit': limit, 'sw': superseded_weight}).fetchall()
        ms = (time.perf_counter() - started) * 1000
        results = [{
            'chunkId': r[0], 'documentId': r[8], 'versionId': r[2], 'collectionId': r[3], 'title': r[4],
            'excerpt': re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', r[5])[:1200], 'locator': r[6],
            'scores': {'rank': i + 1, 'keyword': round(float(r[10]), 4)},
            'flags': {'supersededBy': r[9], 'instructionLike': r[7]},
        } for i, r in enumerate(rows)]
        top = results[0]['scores']['keyword'] if results else 0.0
        evidence = 'strong' if top >= strong else 'weak' if top >= weak else 'none'
        self.db.execute('INSERT INTO audit (credential, principal, collections, result_sources, query_sha256) VALUES (%s,%s,%s,%s,%s)',
                        (cred.name, cred.principal, allowed, [r[1] for r in rows], hashlib.sha256(query.encode()).hexdigest()))
        self.db.commit()
        return {'indexGeneration': self.db.execute('SELECT index_generation FROM tenants WHERE id = %s', (cred.tenant,)).fetchone()[0],
                'evidence': evidence, 'results': results, 'ms': ms}

    def original(self, cred: Credential, key: str, collection: str) -> Path:
        """The stored original, under the same permission rule as search; a hidden source is indistinguishable from
        a missing one."""
        groups = [] if cred.principal is None else [r[0] for r in self.db.execute(
            'SELECT group_id FROM group_members WHERE tenant_id = %s AND principal_id = %s', (cred.tenant, cred.principal))]
        allowed = cred.collections or [r[0] for r in self.db.execute('SELECT id FROM collections WHERE tenant_id = %s', (cred.tenant,))]
        row = self.db.execute("""
            SELECT v.original_path FROM sources s JOIN collections c ON c.id = s.collection_id
            JOIN versions v ON v.source_id = s.id AND v.n = s.current_version
            WHERE s.key = %s AND s.collection_id = %s AND c.tenant_id = %s AND s.collection_id = ANY(%s) AND s.status = 'active'
              AND (s.acl_all OR s.acl_groups && %s::text[] OR %s = ANY(s.acl_principals))""",
            (key, collection, cred.tenant, allowed, groups, cred.principal or '')).fetchone()
        self.db.commit()
        if not row or not row[0]:
            raise FileNotFoundError('not-found')
        return Path(row[0])
