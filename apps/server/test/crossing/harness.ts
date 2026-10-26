import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql } from 'drizzle-orm';
import { PERMISSIONS, ROLES, type Permission, type Role } from '@hf/shared';
import type { TestApp } from '../helpers/testApp.js';
import type { RouteAccess } from '../../src/http/route.js';
import { SESSION_COOKIE, SESSION_ABSOLUTE_MS, hashToken } from '../../src/auth/sessions.js';
import { sessions } from '../../src/db/schema/index.js';
import { ACTORS, type ActorKey, type World, type WorldActor, type WorldResource } from './world.js';
import { sees } from './oracle.js';
import { EXPECTED_PUBLIC, EXPECTED_ROLES, type CrossingCase, type Route } from './cases.js';

export interface CrossingFailure {
  route: Route;
  actor: ActorKey | null;
  resource?: string;
  kind: 'status' | 'leak' | 'missing' | 'changed' | 'mass-assignment' | 'permission';
  sentence: string;
}

const CASES_FILE = 'test/crossing/cases.ts';
const MAX_PAGES = 100;

/** `a`, `a and b`, `a, b and c`. */
function joinList(items: readonly string[]): string {
  if (items.length === 0) return 'no role';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

const inRoleOrder = (roles: readonly Role[]): Role[] => ROLES.filter((r) => roles.includes(r));
const routeKey = (r: { method: string; url: string }): string => `${r.method} ${r.url}`;

/**
 * Plain-English lines for every gap in the crossing table. Empty means every route is covered.
 * `expected` defaults to the hand-written EXPECTED_ROLES; public routes are checked against EXPECTED_PUBLIC.
 */
export function uncoveredRoutes(
  app: FastifyInstance,
  cases: CrossingCase[],
  expected: Record<string, readonly Role[]> = EXPECTED_ROLES,
  expectedPublic: readonly string[] = EXPECTED_PUBLIC,
): string[] {
  const lines: string[] = [];
  const caseRoutes = new Set<string>(cases.map((c) => c.route));
  const declared = new Set(app.hf.routes.map(routeKey));
  for (const r of app.hf.routes) {
    const key = routeKey(r);
    if (!caseRoutes.has(key)) lines.push(`${key} has no role-crossing check. Add one to ${CASES_FILE}.`);
    if ('permission' in r.access) {
      if (!(key in expected)) lines.push(`${key} has no entry in EXPECTED_ROLES. Say which roles may call it in ${CASES_FILE}.`);
      if (expectedPublic.includes(key)) {
        lines.push(`${key} needs the permission ${r.access.permission}, but the crossing table lists it as public. Fix the route or EXPECTED_PUBLIC in ${CASES_FILE}.`);
      }
    } else if (!expectedPublic.includes(key)) {
      lines.push(`${key} is open to everyone without signing in, but the crossing table does not list it as public. Give it a permission, or if it really is public, add it to EXPECTED_PUBLIC in ${CASES_FILE}.`);
    }
  }
  // Entries and cases that name a route the app does not have are stale or misspelt.
  for (const key of Object.keys(expected)) {
    if (!declared.has(key)) lines.push(`${key} is listed in EXPECTED_ROLES, but no such route exists. Remove it or fix the spelling in ${CASES_FILE}.`);
  }
  for (const key of expectedPublic) {
    if (!declared.has(key)) lines.push(`${key} is listed in EXPECTED_PUBLIC, but no such route exists. Remove it or fix the spelling in ${CASES_FILE}.`);
  }
  for (const key of caseRoutes) {
    if (!declared.has(key)) lines.push(`A case names ${key}, but no such route exists. Remove it or fix the spelling in ${CASES_FILE}.`);
  }

  const allowed = new Set(app.hf.staticRoutes.map(routeKey));
  const seen = new Set<string>();
  for (const r of app.hf.allRoutes) {
    const key = routeKey(r);
    if (declared.has(key) || allowed.has(key) || seen.has(key)) continue;
    // Fastify adds a HEAD for each GET; that is fine only when the GET itself is declared (or an allowed static file).
    const get = `GET ${r.url}`;
    if (r.method === 'HEAD' && (declared.has(get) || allowed.has(get))) continue;
    seen.add(key);
    lines.push(`${key} was registered without defineRoute. Every route must declare its permission.`);
  }
  return lines;
}

/**
 * Every public table except the audit log, as `table -> 'count:md5'`. Ordering by the row text keeps it stable when nothing changed.
 * - audit_log is left out: a refused attempt may be audited, by design.
 * - sessions is reduced to (id, user_id), because last_seen_at may be touched by any request, and the sessions in
 *   `ignoreSessionIds` are left out: the harness plants the disabled actor's session before each of his requests,
 *   and the session layer deletes it on sight, by design.
 * - email_outbox stays in: a refused invite must not queue mail.
 */
export async function dbFingerprint(t: TestApp, opts: { ignoreSessionIds?: string[] } = {}): Promise<Record<string, string>> {
  const tables = await t.db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public' order by tablename`);
  const ignored = (opts.ignoreSessionIds ?? []).map((id) => `'${id.replace(/[^0-9a-f]/g, '')}'`);
  const out: Record<string, string> = {};
  for (const { tablename } of tables.rows) {
    if (tablename === 'audit_log') continue;
    const from = tablename === 'sessions'
      ? `(select id, user_id from sessions${ignored.length ? ` where id not in (${ignored.join(', ')})` : ''})`
      : `"${tablename}"`;
    const res = await t.db.execute<{ fp: string }>(sql.raw(
      `select count(*) || ':' || coalesce(md5(string_agg(row_to_json(x)::text, '' order by row_to_json(x)::text)), '') as fp from ${from} x`,
    ));
    out[tablename] = res.rows[0]?.fp ?? '';
  }
  return out;
}

async function rowHash(t: TestApp, table: string, id: string): Promise<string | null> {
  const res = await t.db.execute<{ h: string }>(sql`select md5(row_to_json(x)::text) as h from ${sql.identifier(table)} x where x.id = ${id}`);
  return res.rows[0]?.h ?? null;
}

function changedTables(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
}

const defaultOk = (method: string): number => (method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200);
const is2xx = (s: number): boolean => s >= 200 && s < 300;
const tokenOf = (cookie: string): string => cookie.slice(cookie.indexOf('=') + 1);

/** True when the reply sets the session cookie to a real value (clearing it is fine). */
function setsSessionCookie(res: LightMyRequestResponse): boolean {
  const raw = res.headers['set-cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.some((c) => {
    const m = new RegExp(`^\\s*${SESSION_COOKIE}=([^;]*)`).exec(c);
    return m !== null && m[1] !== '';
  });
}

/** Whether denial checks apply. Every method but GET changes something unless the case says otherwise, with a reason. */
function mutatesOf(c: CrossingCase, method: string): boolean {
  if (c.kind === 'list') return false;
  if (c.mutates === false) {
    if (method !== 'GET' && !c.why) throw new Error(`${c.route} is marked as changing nothing, but gives no reason. Add why to the case in ${CASES_FILE}.`);
    return false;
  }
  return c.mutates ?? method !== 'GET';
}

/**
 * Sends every case as every actor and checks the status, session cookies, canaries and ids, list completeness
 * (across every page), that a refusal changed nothing, and mass assignment. Expected outcomes come only from the
 * hand-written oracle and tables.
 */
export async function runCrossing(
  world: World,
  cases: CrossingCase[],
  expected: Record<string, readonly Role[]> = EXPECTED_ROLES,
  expectedPublic: readonly string[] = EXPECTED_PUBLIC,
): Promise<{ checks: number; failures: CrossingFailure[] }> {
  const { t } = world;
  const failures: CrossingFailure[] = [];
  let checks = 0;
  const declared = new Map<string, RouteAccess>(t.app.hf.routes.map((r) => [routeKey(r), r.access]));

  // Problems with the table itself are errors, not quiet passes.
  for (const c of cases) {
    if (!(c.route in expected) && !expectedPublic.includes(c.route)) throw new Error(`${c.route} has no entry in EXPECTED_ROLES.`);
    if ((c.kind === 'item' || c.kind === 'list') && (world.resources[c.resource] ?? []).length === 0) {
      throw new Error(`${c.route} uses the resource type "${c.resource}", but the world has no rows of that type. Check the spelling, or add a seeder to RESOURCE_SEEDERS.`);
    }
    mutatesOf(c, c.route.split(' ', 1)[0]!);
  }

  // The declared permission against the hand-written table, once per route named by the cases.
  for (const route of new Set(cases.map((c) => c.route))) {
    if (!(route in expected)) continue; // public
    const access = declared.get(route);
    if (!access || !('permission' in access)) continue;
    const perm: Permission = access.permission;
    const granted = inRoleOrder((PERMISSIONS as Record<string, readonly Role[] | undefined>)[perm] ?? []);
    const wanted = inRoleOrder(expected[route]!);
    checks++;
    if (granted.length !== wanted.length || granted.some((r) => !wanted.includes(r))) {
      failures.push({
        route, actor: null, kind: 'permission',
        sentence: `${route} lets ${joinList(granted)} in (permission ${perm}), but the crossing table says only ${joinList(wanted)} should. Fix the route's permission or PERMISSIONS; if the rule really changed, update EXPECTED_ROLES in ${CASES_FILE}.`,
      });
    }
  }

  const allResources = (): WorldResource[] => Object.values(world.resources).flat();
  // Actors who hold a session they must not be able to use (the disabled one).
  const deadSessions = (): { a: WorldActor; id: string }[] =>
    ACTORS.map((k) => world.actors[k]).filter((a) => !a.signedIn && a.cookie && a.id).map((a) => ({ a, id: hashToken(tokenOf(a.cookie!)) }));
  const fingerprint = () => dbFingerprint(t, { ignoreSessionIds: deadSessions().map((d) => d.id) });

  /** The session layer deletes a dead session on sight, so it is planted again before each of that actor's requests. */
  const plantDeadSession = async (a: WorldActor): Promise<void> => {
    const dead = deadSessions().find((d) => d.a.key === a.key);
    if (!dead) return;
    const now = new Date();
    await t.db.insert(sessions).values({ id: dead.id, userId: a.id!, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS) })
      .onConflictDoNothing();
  };

  const send = async (a: WorldActor, method: string, url: string, body: unknown): Promise<LightMyRequestResponse> => {
    await plantDeadSession(a);
    const headers: Record<string, string> = { origin: t.config.appOrigin };
    if (a.cookie) headers['cookie'] = a.cookie;
    return t.app.inject({
      method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE', url, headers,
      ...(body === undefined ? {} : { payload: body as object }),
    });
  };

  /** Status before item rules: 401, then 403 from the hand-written role table, or null to go on. */
  const gate = (a: WorldActor, route: Route): number | null => {
    if (!(route in expected)) return null; // public
    if (!a.signedIn || a.role === null) return 401;
    if (!expected[route]!.includes(a.role)) return 403;
    return null;
  };

  /** Checks every reply gets: a session cookie only with success, and no canary or id of anything the actor may not see. */
  const scan = (a: WorldActor, route: Route, res: LightMyRequestResponse, requestedId: string | undefined): void => {
    checks++;
    if (!is2xx(res.statusCode) && setsSessionCookie(res)) {
      failures.push({ route, actor: a.key, kind: 'leak',
        sentence: `${a.key} got a session cookie from ${route} although the answer was ${String(res.statusCode)}.` });
    }
    checks++;
    const text = res.body.toLowerCase();
    for (const other of allResources()) {
      if (sees(a, other)) continue;
      if (text.includes(other.canary.toLowerCase())) {
        failures.push({ route, actor: a.key, resource: other.key, kind: 'leak',
          sentence: `${a.key} could see ${other.key}'s ${other.type} data (${other.canary}) in the answer from ${route}.` });
      } else if (other.id !== requestedId && text.includes(other.id.toLowerCase())) {
        failures.push({ route, actor: a.key, resource: other.key, kind: 'leak',
          sentence: `${a.key} could see ${other.key}'s ${other.type} id (${other.id}) in the answer from ${route}.` });
      }
    }
  };

  const changedSentence = (a: WorldActor, route: Route, status: number, want: number, what: string): string =>
    is2xx(status)
      ? `${a.key}'s ${route} should have been refused (expected ${String(want)}), but it went through and changed ${what}.`
      : `${a.key}'s ${route} was refused, but ${what} changed anyway.`;

  /** Replays the body with each forbidden field added. Each must get 400 and change nothing at all. */
  const massAssign = async (a: WorldActor, c: CrossingCase & { forbiddenFields?: Record<string, unknown>[] }, method: string, url: string, base: unknown, r?: WorldResource) => {
    for (const field of c.forbiddenFields ?? []) {
      const body = { ...(typeof base === 'object' && base !== null ? base : {}), ...field };
      const target = r ? { table: r.table, id: r.id } : { table: 'users', id: a.id! };
      const rowBefore = await rowHash(t, target.table, target.id);
      const fpBefore = await fingerprint();
      const res = await send(a, method, url, body);
      scan(a, c.route, res, r?.id);
      checks += 3;
      const rowSame = (await rowHash(t, target.table, target.id)) === rowBefore;
      const changed = changedTables(fpBefore, await fingerprint());
      if (res.statusCode !== 400 || !rowSame || changed.length > 0) {
        const names = Object.keys(field).map((k) => `"${k}"`).join(', ');
        failures.push({ route: c.route, actor: a.key, ...(r ? { resource: r.key } : {}), kind: 'mass-assignment',
          sentence: `${a.key} could send ${names} to ${c.route}${r ? ` for ${r.key} (${r.type})` : ''}; it should have been refused.` });
      }
      if (is2xx(res.statusCode) || !rowSame || changed.length > 0) await world.reset();
    }
  };

  for (const c of cases) {
    const [method, path] = c.route.split(' ', 2) as [string, string];
    const mutates = mutatesOf(c, method);
    for (const actorKey of ACTORS) {
      const a = world.actors[actorKey];
      const targets: (WorldResource | undefined)[] = c.kind === 'item' ? [...(world.resources[c.resource] ?? [])] : [undefined];
      for (const r of targets) {
        // Expected status, from the oracle only.
        let want = gate(a, c.route);
        if (want === null && c.kind === 'item' && r) {
          if (!(c.visible ?? sees)(a, r)) want = 404;
          else if (c.allowed && !c.allowed(a, r)) want = 403;
        }
        if (want === null) {
          const ok = c.kind === 'list' ? undefined : c.okStatus;
          want = typeof ok === 'function' ? ok(r!, a) : (ok ?? defaultOk(method));
        }

        const base = r ? path.replaceAll(':id', r.id) : path;
        const body = c.kind === 'item' ? c.body?.(r!) : c.kind === 'action' ? c.body?.(world) : undefined;
        const watch = mutates && !is2xx(want);
        const rowBefore = watch && r ? await rowHash(t, r.table, r.id) : null;
        const fpBefore = watch ? await fingerprint() : null;

        // Lists follow the cursor to the end, so a leak on a later page is seen.
        const replies: LightMyRequestResponse[] = [];
        let query = c.kind === 'list' ? (c.paginate?.query ?? c.query) : undefined;
        for (;;) {
          const res = await send(a, method, base + (query ? `?${query}` : ''), body);
          replies.push(res);
          if (c.kind !== 'list' || !c.paginate || res.statusCode !== 200) break;
          const next = c.paginate.next(res.json());
          if (next === null) break;
          if (replies.length >= MAX_PAGES) throw new Error(`${c.route} still had more pages after ${String(MAX_PAGES)}; check the case's paginate.next.`);
          query = next;
        }
        const about = r ? ` for ${r.key} (${r.type})` : '';
        let dirty = false;

        for (const res of replies) {
          // 1. Status.
          checks++;
          if (res.statusCode !== want) {
            failures.push({ route: c.route, actor: actorKey, ...(r ? { resource: r.key } : {}), kind: 'status',
              sentence: `${actorKey} got ${String(res.statusCode)} from ${c.route}${about}; expected ${String(want)}.` });
          }
          // 2. Leak: no session cookie on a refusal, and no canary or id of anything this actor may not see.
          scan(a, c.route, res, r?.id);
        }
        const last = replies[replies.length - 1]!;

        // 3. List completeness, across every page.
        if (c.kind === 'list' && replies.every((res) => res.statusCode === 200)) {
          const text = replies.map((res) => res.body.toLowerCase()).join('\n');
          for (const v of world.resources[c.resource] ?? []) {
            if (!(c.visible ?? sees)(a, v)) continue;
            checks++;
            if (!text.includes(v.canary.toLowerCase())) {
              failures.push({ route: c.route, actor: actorKey, resource: v.key, kind: 'missing',
                sentence: `${actorKey}'s list from ${c.route} left out ${v.key} (${v.type}), which they are allowed to see.` });
            }
          }
        }

        // 4. Unchanged after a refusal.
        if (watch) {
          if (r) {
            checks++;
            if ((await rowHash(t, r.table, r.id)) !== rowBefore) {
              dirty = true;
              failures.push({ route: c.route, actor: actorKey, resource: r.key, kind: 'changed',
                sentence: changedSentence(a, c.route, last.statusCode, want, `${r.key} (${r.type})`) });
            }
          }
          checks++;
          const changed = changedTables(fpBefore!, await fingerprint());
          if (changed.length > 0) {
            dirty = true;
            failures.push({ route: c.route, actor: actorKey, ...(r ? { resource: r.key } : {}), kind: 'changed',
              sentence: is2xx(last.statusCode)
                ? `${actorKey}'s ${c.route} should have been refused (expected ${String(want)}), but it went through and changed the database (${changed.join(', ')}).`
                : `${actorKey}'s ${c.route} was refused, but the database changed anyway (${changed.join(', ')}).` });
          }
        }

        // An allowed change (or one that got through when it should not have) is undone before the next request.
        if (mutates && (is2xx(want) || is2xx(last.statusCode) || dirty)) await world.reset();

        // 5. Mass assignment on an item: each permitted actor, on each row they may change.
        if (c.kind === 'item' && r && c.forbiddenFields && gate(a, c.route) === null && (c.visible ?? sees)(a, r) && (!c.allowed || c.allowed(a, r))) {
          await massAssign(a, c, method, base, c.body?.(r), r);
        }
      }

      // 5. Mass assignment on an action: each permitted actor.
      if (c.kind === 'action' && c.forbiddenFields && a.signedIn && a.id !== null && gate(a, c.route) === null) {
        await massAssign(a, c, method, path, c.body?.(world));
      }
    }
  }
  return { checks, failures };
}
