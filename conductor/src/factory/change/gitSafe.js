// src/factory/change/gitSafe.js — the small checks every change module shares (Plan 11 final review, item 7):
// the git environment that never follows Conductor's own GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE, what counts as a
// full commit id and as a release tag, and plain versions. One copy, so the modules cannot drift apart.
import { parseVersion } from '../foundationLog.js';

// Spread into every git call's env: git works on the repository named by its folder, never one the caller's env names.
export const CLEAN_GIT_ENV = Object.freeze({ GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined });
// A full 40-hex commit id: never anything git could read as an option, a range or a branch name.
export const SHA_RE = /^[0-9a-f]{40}$/;
// A release tag v<major>.<minor>.<patch>, without leading zeros (one stray tag cannot break the sort).
export const RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);
export const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
// A path inside the repository as Git names it: relative, forward slashes, no empty, "." or ".." parts, no NUL.
export const isRepoPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.includes('\0')
  && p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** The parsed version when `s` is a plain x.y.z (no pre-release, no build metadata), otherwise null. */
export function plainVersion(s) {
  const v = parseVersion(s);
  return v && s === `${v.major}.${v.minor}.${v.patch}` ? v : null;
}
