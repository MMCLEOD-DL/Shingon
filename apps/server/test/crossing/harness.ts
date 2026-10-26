import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { PERMISSIONS, ROLES, type Permission, type Role } from '@hf/shared';
import type { TestApp } from '../helpers/testApp.js';
import type { RouteAccess } from '../../src/http/route.js';
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
  const declared = new Set(app.hf.routes.map(routeKey));
  const allowed = new Set(app.hf.staticRoutes.map(routeKey));
  const seen = new Set<string>();
  for (const r of app.hf.allRoutes) {
    const key = routeKey(r);
    if (r.method === 'HEAD' || declared.has(key) || allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    lines.push(`${key} was registered without defineRoute. Every route must declare its permission.`);
  }
  return lines;
}

/** Every public table except two, as `table -> 'count:md5'`. Ordering by the row text keeps it stable when nothing changed. */
export async function dbFingerprint(t: TestApp): Promise<Record<string, string>> {
  // Left out on purpose:
  // - sessions: the session layer deletes a dead session on sight (disabledDave's, on every request), by design;
  // - audit_log: a refused attempt may be audited, by design.
  // email_outbox stays in: a refused invite must not queue mail.
  const EXCLUDED = new Set(['sessions', 'audit_log']);
  const tables = await t.db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public' order by tablename`);
  const out: Record<string, string> = {};
  for (const { tablename } of tables.rows) {
    if (EXCLUDED.has(tablename)) continue;
    const res = await t.db.execute<{ fp: string }>(sql.raw(
      `select count(*) || ':' || coalesce(md5(string_agg(row_to_json(x)::text, '' order by row_to_json(x)::text)), '') as fp from "${tablename}" x`,
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

/**
 * Sends every case as every actor and checks the status, canaries, list completeness, that a refusal changed
 * nothing, and mass assignment. Expected outcomes come only from the hand-written oracle and tables.
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

  // The declared permission against the hand-written table, once per route named by the cases.
  for (const route of new Set(cases.map((c) => c.route))) {
    const isPublic = !(route in expected) && expectedPublic.includes(route);
    if (!(route in expected) && !isPublic) throw new Error(`${route} has no entry in EXPECTED_ROLES.`);
    const access = declared.get(route);
    if (!access || !('permission' in access) || isPublic) continue;
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

  const send = (a: WorldActor, method: string, url: string, body: unknown) => {
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

  for (const c of cases) {
    const [method, path] = c.route.split(' ', 2) as [string, string];
    const mutates = c.kind !== 'list' && c.mutates === true;
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

        const url = (r ? path.replaceAll(':id', r.id) : path) + (c.kind === 'list' && c.query ? `?${c.query}` : '');
        const body = c.kind === 'item' ? c.body?.(r!) : c.kind === 'action' ? c.body?.(world) : undefined;
        const watch = mutates && !is2xx(want);
        const rowBefore = watch && r ? await rowHash(t, r.table, r.id) : null;
        const fpBefore = watch ? await dbFingerprint(t) : null;

        const res = await send(a, method, url, body);
        const text = res.body;
        const about = r ? ` for ${r.key} (${r.type})` : '';
        let dirty = false;

        // 1. Status.
        checks++;
        if (res.statusCode !== want) {
          failures.push({ route: c.route, actor: actorKey, ...(r ? { resource: r.key } : {}), kind: 'status',
            sentence: `${actorKey} got ${String(res.statusCode)} from ${c.route}${about}; expected ${String(want)}.` });
        }

        // 2. Leak: no canary of anything this actor may not see, of any type.
        checks++;
        for (const other of allResources()) {
          if (!sees(a, other) && text.includes(other.canary)) {
            failures.push({ route: c.route, actor: actorKey, resource: other.key, kind: 'leak',
              sentence: `${actorKey} could see ${other.key}'s ${other.type} data (${other.canary}) in the answer from ${c.route}.` });
          }
        }

        // 3. List completeness.
        if (c.kind === 'list' && res.statusCode === 200) {
          for (const v of world.resources[c.resource] ?? []) {
            if (!(c.visible ?? sees)(a, v)) continue;
            checks++;
            if (!text.includes(v.canary)) {
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
                sentence: `${actorKey}'s ${c.route} was refused, but ${r.key} (${r.type}) changed anyway.` });
            }
          }
          checks++;
          const changed = changedTables(fpBefore!, await dbFingerprint(t));
          if (changed.length > 0) {
            dirty = true;
            failures.push({ route: c.route, actor: actorKey, ...(r ? { resource: r.key } : {}), kind: 'changed',
              sentence: `${actorKey}'s ${c.route} was refused, but the database changed anyway (${changed.join(', ')}).` });
          }
        }

        // An allowed change (or one that got through when it should not have) is undone before the next request.
        if (mutates && (is2xx(want) || is2xx(res.statusCode) || dirty)) await world.reset();
      }

      // 5. Mass assignment: each permitted actor tries each forbidden field on top of the normal body.
      if (c.kind === 'action' && c.forbiddenFields && a.signedIn && a.id !== null && gate(a, c.route) === null) {
        for (const field of c.forbiddenFields) {
          const base = c.body?.(world);
          const body = { ...(typeof base === 'object' && base !== null ? base : {}), ...field };
          const before = await rowHash(t, 'users', a.id);
          const res = await send(a, method, path, body);
          checks += 2;
          const after = await rowHash(t, 'users', a.id);
          if (res.statusCode !== 400 || after !== before) {
            failures.push({ route: c.route, actor: actorKey, kind: 'mass-assignment',
              sentence: `${actorKey} could send ${Object.keys(field).map((k) => `"${k}"`).join(', ')} to ${c.route}; it should have been refused.` });
          }
          if (is2xx(res.statusCode) || after !== before) await world.reset();
        }
      }
    }
  }
  return { checks, failures };
}
