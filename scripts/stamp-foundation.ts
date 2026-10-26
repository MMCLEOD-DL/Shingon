import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

/** Reads and checks foundation.json; throws a plain-English problem. */
export function readStamp(file: string): { name: string; version: string; commit: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`foundation.json is missing (looked for ${file}). It records which foundation release this app was built on, so it must stay in the project exactly as it was inherited.`);
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error('foundation.json is not valid JSON. Restore it from the foundation release this app was built on.');
  }
  const o = (typeof j === 'object' && j !== null ? j : {}) as Record<string, unknown>;
  const { name, version, commit } = o;
  if (name !== 'highland-foundation' || typeof version !== 'string' || semver.valid(version) === null || typeof commit !== 'string' || commit === '') {
    throw new Error('foundation.json is damaged: it needs the name "highland-foundation", a version such as 0.1.0 and a commit. Restore it from the foundation release this app was built on.');
  }
  return { name, version, commit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const stamp = readStamp(path.resolve(process.argv[2] ?? 'foundation.json'));
    console.log(`Built on highland-foundation ${stamp.version}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
