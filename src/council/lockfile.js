// src/council/lockfile.js
// Reads npm lockfiles (v1/v2/v3) for the dependency checks (Security and Legal).
import { git } from '../workspace.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const hasLicenceData = (lock) => isObj(lock) && isObj(lock.packages);

export function lockPackages(lock) {
  if (!isObj(lock)) return [];
  const out = [];
  const add = (name, e) => out.push({ name, version: String(e.version ?? ''), license: typeof e.license === 'string' ? e.license : null, dev: e.dev === true });
  if (isObj(lock.packages)) {
    for (const [key, e] of Object.entries(lock.packages)) {
      const at = key.lastIndexOf('node_modules/');
      if (!key || at < 0 || !isObj(e) || e.link === true) continue; // root, workspace packages and links are the project's own code
      add(key.slice(at + 'node_modules/'.length), e);
    }
    return out;
  }
  const walk = (deps) => { for (const [name, e] of Object.entries(isObj(deps) ? deps : {})) if (isObj(e)) { add(name, e); walk(e.dependencies); } };
  walk(lock.dependencies);
  return out;
}

export async function readLock(dir, sha = null) {
  try {
    let text;
    if (sha === null) text = await readFile(path.join(dir, 'package-lock.json'), 'utf8');
    else {
      const r = await git(dir, ['show', `${sha}:package-lock.json`]);
      if (r.code !== 0) return null;
      text = r.stdout;
    }
    const lock = JSON.parse(text);
    return isObj(lock) ? lock : null;
  } catch { return null; }
}

// Names that have a name@version in head that base does not have.
export function lockDelta(basePkgs, headPkgs) {
  const have = new Set(basePkgs.map((p) => `${p.name}@${p.version}`));
  return new Set(headPkgs.filter((p) => !have.has(`${p.name}@${p.version}`)).map((p) => p.name));
}
