// src/factory/ship/releaseContent.js — what a release may change (Ruling S20, and the Plan 11 Task 7/9 content
// ruling). Shared by Plan 10's releaseApp/approvedRelease and Plan 11's mainline checks, so both refuse the same
// releases: imported by src/factory/ship/release.js and src/factory/change/mainline.js, and importing neither.
import { git as workspaceGit } from '../../workspace.js';
import { CLEAN_GIT_ENV, isSha, isObject } from '../change/gitSafe.js';

// Ruling S20: the only files a release (and the first release's preparation) may change.
export const RELEASE_FILES = Object.freeze(['CHANGELOG.md', 'package.json', 'package-lock.json', 'foundation.json']);

export const RELEASE_CHANGED_SETTINGS = (files) => `The release step changed more than the version numbers in ${files.join(', ')}, so nothing was shipped.`;
export const RELEASE_UNCHECKABLE = 'Conductor could not check the release, so nothing was shipped.';
export const NO_RELEASE_GIVEN = 'Conductor was not given a release it can check, so nothing was shipped.';

const DIFF_NAMES = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z'];
const REGULAR_MODES = new Set(['100644', '100755']);
const defaultGit = (dir, args) => workspaceGit(dir, args, { env: CLEAN_GIT_ENV });

// One `ls-tree -z` entry for a top-level file: { mode, type } or null when the commit has no such entry.
async function treeEntry(git, appDir, sha, file) {
  const r = await git(appDir, ['ls-tree', '-z', sha, '--', file]);
  if (r.code !== 0) throw new Error('unreadable');
  const entry = String(r.stdout).split('\0').find((e) => e.slice(e.indexOf('\t') + 1) === file);
  if (!entry) return null;
  const [mode, type] = entry.slice(0, entry.indexOf('\t')).split(' ');
  return { mode, type };
}

// Canonical JSON (keys sorted), so only content counts, never key order.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

// What a release may change in each JSON release file (the foundation's scripts/release.ts): the version in
// package.json, package-lock.json (top and packages[""]) and foundation.json, and foundation.json's commit stamp, which
// it sets to the new tag name. True when `before` and `after` differ in nothing else.
function sameApartFromRelease(file, before, after) {
  if (!isObject(before) || !isObject(after)) return false;
  const strip = (j, stamp) => {
    const c = structuredClone(j);
    delete c.version;
    if (stamp) delete c.commit;
    if (file === 'package-lock.json' && isObject(c.packages) && isObject(c.packages[''])) delete c.packages[''].version;
    return JSON.stringify(canonical(c));
  };
  const stamp = file === 'foundation.json' && (after.commit === before.commit || after.commit === `v${after.version}`);
  return strip(before, stamp) === strip(after, stamp);
}

/**
 * Between `base` and `head`, the release files may change only as a release changes them: each stays a regular file
 * with the same mode (no link, no submodule, none added or removed), package.json, package-lock.json and
 * foundation.json differ only in their version fields (and foundation.json's commit stamp), CHANGELOG.md is free text.
 * Files outside RELEASE_FILES are not looked at here. null when fine, otherwise the plain reason (fails closed).
 * `git(dir, args)` → { code, stdout } runs git (default: Conductor's own, without the caller's GIT_DIR and friends).
 */
export async function releaseContentProblem(appDir, base, head, { git = defaultGit } = {}) {
  if (!isSha(base) || !isSha(head)) return NO_RELEASE_GIVEN;
  const names = await git(appDir, [...DIFF_NAMES, base, head]);
  if (names.code !== 0) return RELEASE_UNCHECKABLE;
  const changed = String(names.stdout).split('\0').filter((f) => RELEASE_FILES.includes(f));
  const bad = [];
  try {
    for (const file of changed) {
      const before = await treeEntry(git, appDir, base, file);
      const after = await treeEntry(git, appDir, head, file);
      if (!before || !after || after.type !== 'blob' || before.type !== 'blob' || !REGULAR_MODES.has(after.mode) || after.mode !== before.mode) {
        bad.push(file);
        continue;
      }
      if (file === 'CHANGELOG.md') continue;
      const a = await git(appDir, ['show', `${base}:${file}`]);
      const b = await git(appDir, ['show', `${head}:${file}`]);
      if (a.code !== 0 || b.code !== 0) return RELEASE_UNCHECKABLE;
      let same;
      try { same = sameApartFromRelease(file, JSON.parse(a.stdout), JSON.parse(b.stdout)); } catch { same = false; }
      if (!same) bad.push(file);
    }
  } catch {
    return RELEASE_UNCHECKABLE;
  }
  return bad.length ? RELEASE_CHANGED_SETTINGS(bad) : null;
}
