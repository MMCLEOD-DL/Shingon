/**
 * Optional modules and the data policy (Plan 12 Ruling 7). `app-profile.json` at the repo root says which modules
 * are on and what may leave the box; it is read once at start-up (server, ops) and at build time (web).
 */
import { z } from 'zod';

export const MODULES = ['ocr', 'pdf-export', 'xlsx-export', 'scheduled-jobs'] as const;
export type ModuleName = typeof MODULES[number];

export const RESIDENCIES = ['uk', 'uk-eu', 'any'] as const;
export type Residency = typeof RESIDENCIES[number];

const OUTBOUND_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const AppProfileSchema = z.strictObject({
  schema: z.literal(1),
  modules: z.array(z.enum(MODULES)),
  policy: z.strictObject({
    outbound: z.array(z.string().regex(OUTBOUND_ID)),
    residency: z.enum(RESIDENCIES),
  }),
});
export type AppProfile = z.infer<typeof AppProfileSchema>;

export const DEFAULT_PROFILE: AppProfile = { schema: 1, modules: [], policy: { outbound: [], residency: 'uk' } };

/** Whether a module is switched on. Decided at start-up, never per request. */
export function moduleOn(cfg: { profile: AppProfile }, m: ModuleName): boolean {
  return cfg.profile.modules.includes(m);
}

export type AppProfileResult = { ok: true; profile: AppProfile } | { ok: false; problems: string[] };

const FILE = 'app-profile.json';
/** "a, b or c" (one item as it is), for the choices in a plain sentence. */
export const orList = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1) ?? ''}`);

const valueAt = (data: unknown, path: readonly PropertyKey[]): unknown => {
  let v = data;
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<PropertyKey, unknown>)[k];
  }
  return v;
};

/** One plain sentence per Zod issue; Zod's own wording never reaches the operator. */
function sentence(issue: z.core.$ZodIssue, data: unknown): string[] {
  const path = issue.path;
  const where = path.filter((k) => typeof k === 'string').join('.');
  const value = valueAt(data, path);
  if (issue.code === 'unrecognized_keys') return issue.keys.map((k) => `${FILE} has an unknown setting "${where ? `${where}.` : ''}${k}".`);
  if (path.length === 0) return [`${FILE} must hold one set of settings in braces, like { "schema": 1, "modules": [], "policy": { "outbound": [], "residency": "uk" } }.`];
  if (where === 'schema') return [`${FILE} must say "schema": 1.`];
  if (path[0] === 'modules' && path.length === 2) {
    return [typeof value === 'string'
      ? `${FILE} lists an unknown module "${value}". Use ${orList(MODULES)}.`
      : `${FILE} lists a module that is not a name. Use ${orList(MODULES)}.`];
  }
  if (where === 'policy.outbound' && path.length === 3) {
    return [typeof value === 'string'
      ? `${FILE} has an outbound service "${value}" that is not a valid name. Use lower-case letters, digits and dashes, like azure-document-intelligence.`
      : `${FILE} has an outbound service that is not a name. Use lower-case letters, digits and dashes, like azure-document-intelligence.`];
  }
  if (where === 'policy.residency' && typeof value === 'string') return [`${FILE} has an unknown residency "${value}". Use ${orList(RESIDENCIES)}.`];
  if (value === undefined) return [`${FILE} is missing "${where}".`];
  if (where === 'policy') return [`${FILE} must give the policy in braces, like "policy": { "outbound": [], "residency": "uk" } (residency is ${orList(RESIDENCIES)}).`];
  if (where === 'modules') return [`${FILE} must list its modules in square brackets, like "modules": ["ocr"].`];
  if (where === 'policy.outbound') return [`${FILE} must list its outbound services in square brackets, like "outbound": [].`];
  if (where === 'policy.residency') return [`${FILE} must give the residency as uk, uk-eu or any.`];
  return [`${FILE} has a setting "${where}" that is not right.`];
}

/** Checks parsed JSON against the profile's shape, with every problem as a plain sentence. */
export function checkAppProfile(data: unknown): AppProfileResult {
  const problems: string[] = [];
  const parsed = AppProfileSchema.safeParse(data);
  if (!parsed.success) for (const issue of parsed.error.issues) problems.push(...sentence(issue, data));
  const repeated = (path: readonly string[], what: string): void => {
    const list = valueAt(data, path);
    if (!Array.isArray(list)) return;
    const seen = new Set<unknown>();
    for (const x of list) {
      if (seen.has(x) && typeof x === 'string') problems.push(`${FILE} lists the ${what} "${x}" twice.`);
      seen.add(x);
    }
  };
  repeated(['modules'], 'module');
  repeated(['policy', 'outbound'], 'outbound service');
  const unique = [...new Set(problems)];
  return parsed.success && unique.length === 0 ? { ok: true, profile: parsed.data } : { ok: false, problems: unique };
}

/** Reads the text of app-profile.json; `null` (no file) gives the default profile. */
export function parseAppProfile(text: string | null): AppProfileResult {
  if (text === null) return { ok: true, profile: structuredClone(DEFAULT_PROFILE) };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problems: [`${FILE} could not be read as JSON. Check the file for a typing mistake.`] };
  }
  return checkAppProfile(data);
}
