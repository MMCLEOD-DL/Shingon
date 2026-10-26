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

interface Found { name: string; version: string; licence: string | undefined; path: string }

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

async function walk(nm: string, out: Found[], scope = ''): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(nm);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (entry === '.bin' || entry === '.package-lock.json') continue;
    const dir = path.join(nm, entry);
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (entry.startsWith('@')) {
      await walk(dir, out, `${entry}/`);
      continue;
    }
    try {
      const pj = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      out.push({
        name: `${scope}${entry}`,
        version: typeof pj['version'] === 'string' ? pj['version'] : '0.0.0',
        licence: normalise(pj),
        path: dir,
      });
    } catch {
      // not a package directory
    }
    await walk(path.join(dir, 'node_modules'), out);
  }
}

export async function collectLicences(rootDir: string): Promise<Found[]> {
  const out: Found[] = [];
  await walk(path.join(rootDir, 'node_modules'), out);
  return out;
}

export async function checkLicences(
  rootDir: string,
  exceptions: Record<string, string>,
): Promise<{ ok: boolean; problems: string[] }> {
  const found = await collectLicences(rootDir);
  const problems: string[] = [];
  const sorted = [...found].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  for (const p of sorted) {
    const id = `${p.name}@${p.version}`;
    if (id in exceptions) continue;
    if (p.licence === undefined || p.licence.trim() === '') {
      problems.push(`${id} has no licence declared. Unknown licences block shipping (spec §5a).`);
    } else if (!isAllowed(p.licence)) {
      problems.push(
        `${id} uses ${p.licence}, which is not on the permissive list (spec §5a). Replace it, or ask the operator to accept it in licence-exceptions.json.`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..');
  const exceptions = JSON.parse(await readFile(path.join(root, 'licence-exceptions.json'), 'utf8')) as Record<string, string>;
  const result = await checkLicences(root, exceptions);
  if (!result.ok) {
    for (const p of result.problems) console.log(p);
    process.exitCode = 1;
    return;
  }
  const n = (await collectLicences(root)).length;
  console.log(`All ${String(n)} packages have permissive licences.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
