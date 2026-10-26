import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED: ReadonlySet<string> = new Set([
  'MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense',
  'CC0-1.0', 'BlueOak-1.0.0', 'CC-BY-4.0', 'Python-2.0',
]);

function stripOuterParens(s: string): string {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')') && !t.slice(1, -1).includes('(')) t = t.slice(1, -1).trim();
  return t;
}

export function isAllowed(expr: string | undefined, allowed: ReadonlySet<string> = ALLOWED): boolean {
  if (expr === undefined) return false;
  const t = stripOuterParens(expr);
  if (t === '' || t.includes('(') || t.includes(')')) return false;
  if (t.includes(' OR ')) return t.split(' OR ').some((p) => isAllowed(p, allowed));
  if (t.includes(' AND ')) return t.split(' AND ').every((p) => isAllowed(p, allowed));
  return allowed.has(t);
}

interface Found { name: string; version: string; licence: string | undefined; path: string; realName?: string }

const NPM_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

function normalise(pj: Record<string, unknown>): string | undefined {
  const l = pj['license'];
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string') return (l as { type: string }).type;
  const ls = pj['licenses'];
  if (Array.isArray(ls)) {
    const ids = ls
      .map((x: unknown) => (typeof x === 'string' ? x : (x as { type?: unknown } | null)?.type))
      .filter((x): x is string => typeof x === 'string');
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) return `(${ids.join(' OR ')})`;
  }
  return undefined;
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

interface Scan { packages: Found[]; errors: string[] }

async function walk(nm: string, scan: Scan, scope = ''): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(nm);
  } catch (e) {
    if (isEnoent(e)) return; // a missing directory is caught by the "nothing installed" check
    throw e;
  }
  for (const entry of entries.sort()) {
    if (entry === '.bin' || entry === '.package-lock.json') continue;
    const dir = path.join(nm, entry);
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (entry.startsWith('@')) {
      await walk(dir, scan, `${entry}/`);
      continue;
    }
    const file = path.join(dir, 'package.json');
    let text: string | undefined;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    if (text !== undefined) {
      try {
        const pj = JSON.parse(text) as Record<string, unknown>;
        const name = `${scope}${entry}`;
        const real = typeof pj['name'] === 'string' && NPM_NAME.test(pj['name']) ? pj['name'] : undefined;
        scan.packages.push({
          name,
          version: typeof pj['version'] === 'string' ? pj['version'] : '0.0.0',
          licence: normalise(pj),
          path: dir,
          ...(real !== undefined && real !== name ? { realName: real } : {}),
        });
      } catch {
        scan.errors.push(`${file} could not be read as JSON, so its licence is unknown. Reinstall with npm ci.`);
      }
    }
    await walk(path.join(dir, 'node_modules'), scan);
  }
}

async function workspaceDirs(rootDir: string): Promise<string[]> {
  let globs: unknown;
  try {
    globs = (JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')) as { workspaces?: unknown }).workspaces;
  } catch (e) {
    if (isEnoent(e)) return [];
    throw e;
  }
  const list = Array.isArray(globs) ? globs : (globs as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(list)) return [];
  const dirs: string[] = [];
  for (const g of list) {
    if (typeof g !== 'string') continue;
    if (g.endsWith('/*')) {
      const base = path.join(rootDir, g.slice(0, -2));
      let names: string[] = [];
      try {
        names = await readdir(base);
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
      for (const n of names.sort()) dirs.push(path.join(base, n));
    } else {
      dirs.push(path.join(rootDir, g));
    }
  }
  return dirs;
}

async function scanAll(rootDir: string): Promise<Scan> {
  const scan: Scan = { packages: [], errors: [] };
  await walk(path.join(rootDir, 'node_modules'), scan);
  for (const dir of await workspaceDirs(rootDir)) await walk(path.join(dir, 'node_modules'), scan);
  return scan;
}

export async function collectLicences(rootDir: string): Promise<Found[]> {
  return (await scanAll(rootDir)).packages;
}

async function runCheck(
  rootDir: string,
  exceptions: Record<string, string>,
): Promise<{ ok: boolean; problems: string[]; count: number }> {
  const { packages, errors } = await scanAll(rootDir);
  if (packages.length === 0 && errors.length === 0) {
    return { ok: false, problems: ['No installed packages found. Run npm ci first, so there is something to check.'], count: 0 };
  }
  const problems: string[] = [];
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  for (const p of sorted) {
    // Exception keys use the folder name (the name it is installed under), not the real name of an alias.
    const id = `${p.name}@${p.version}`;
    const label = p.realName ? `${p.name} (${p.realName})@${p.version}` : id;
    if (Object.hasOwn(exceptions, id)) {
      const reason = exceptions[id];
      if (typeof reason === 'string' && reason.trim() !== '') continue;
      problems.push(`${label} has an entry in licence-exceptions.json but no reason. An exception needs the operator's reason written down (spec §5a).`);
      continue;
    }
    if (p.licence === undefined || p.licence.trim() === '') {
      problems.push(`${label} has no licence declared. Unknown licences block shipping (spec §5a).`);
    } else if (!isAllowed(p.licence)) {
      problems.push(
        `${label} uses ${p.licence}, which is not on the permissive list (spec §5a). Replace it, or ask the operator to accept it in licence-exceptions.json.`,
      );
    }
  }
  problems.push(...errors);
  return { ok: problems.length === 0, problems, count: packages.length };
}

export async function checkLicences(
  rootDir: string,
  exceptions: Record<string, string>,
): Promise<{ ok: boolean; problems: string[] }> {
  const { ok, problems } = await runCheck(rootDir, exceptions);
  return { ok, problems };
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..');
  const raw: unknown = JSON.parse(await readFile(path.join(root, 'licence-exceptions.json'), 'utf8'));
  if (
    typeof raw !== 'object' || raw === null || Array.isArray(raw) ||
    !Object.values(raw).every((v) => typeof v === 'string')
  ) {
    throw new Error('licence-exceptions.json must be an object mapping "name@version" to the operator\'s reason (text).');
  }
  const result = await runCheck(root, raw as Record<string, string>);
  if (!result.ok) {
    for (const p of result.problems) console.log(p);
    process.exitCode = 1;
    return;
  }
  console.log(`All ${String(result.count)} packages have permissive licences.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
