// Port of the foundation's scripts/changelog.ts (securityFixesSince) for a zero-dependency Conductor.
// `semver` is replaced by parseVersion/compareVersions below (strict: no leading 'v' or '=').
import { git } from '../workspace.js';

// Plan 11 extends this file (changesBetween, releaseTags, readChangelogAt); do not redefine these four.

const HEADING = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const SECURITY = /^\s*[-*+]\s*\*\*\[\s*security\s*\]\*\*\s*/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Strict semver x.y.z[-pre][+build] -> { major, minor, patch, pre }, or null. */
export function parseVersion(s) {
  if (typeof s !== 'string') return null;
  const m = VERSION.exec(s);
  if (!m) return null;
  const pre = m[4] === undefined ? [] : m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  const nums = [Number(m[1]), Number(m[2]), Number(m[3])];
  // A number too big to hold exactly would compare wrongly: not a version Conductor can use.
  if (![...nums, ...pre.filter((id) => typeof id === 'number')].every(Number.isSafeInteger)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], pre };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function mustParse(s) {
  const v = parseVersion(s);
  if (v === null) throw new Error(`"${s}" is not a version number such as 1.2.3.`);
  return v;
}

/** Semver precedence (build metadata ignored): -1, 0 or 1. Throws on an invalid version. */
export function compareVersions(a, b) {
  const x = mustParse(a);
  const y = mustParse(b);
  const core = cmp(x.major, y.major) || cmp(x.minor, y.minor) || cmp(x.patch, y.patch);
  if (core !== 0) return core;
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = typeof p === 'number';
    const qn = typeof q === 'number';
    if (pn && qn) return cmp(p, q);
    if (pn) return -1;
    if (qn) return 1;
    return cmp(p, q);
  }
  return cmp(x.pre.length, y.pre.length);
}

/** Splits a Keep a Changelog file on its `## [` headings. `Unreleased` comes back as version 'Unreleased'. */
export function parseChangelog(text) {
  const sections = [];
  for (const chunk of text.split(/^(?=## \[)/m)) {
    const [first = '', ...rest] = chunk.split('\n');
    const m = HEADING.exec(first.trimEnd());
    if (!first.startsWith('## [')) continue; // the title before the first heading
    // Fails closed: a heading that is not understood could hide a security fix, so it stops the check.
    if (!m) throw new Error(`CHANGELOG.md has a heading that is not in the expected form: "${first.trimEnd()}". Use "## [1.2.3] - 2026-01-31" (a two-digit month and day) or "## [Unreleased]".`);
    const version = m[1] ?? '';
    if (version !== 'Unreleased' && parseVersion(version) === null) throw new Error(`CHANGELOG.md has a heading with a version that is not a version number: "${first.trimEnd()}".`);
    sections.push({ version, date: m[2] ?? null, lines: rest.map((l) => l.trimEnd()).filter((l) => l !== '') });
  }
  return sections;
}

/** Released versions newer than `version` that record at least one security fix, newest first, with the marker removed. */
export function securityFixesSince(text, version) {
  if (parseVersion(version) === null) throw new Error(`"${version}" is not a version number such as 1.2.3.`);
  return parseChangelog(text)
    .filter((s) => parseVersion(s.version) !== null && compareVersions(s.version, version) > 0)
    .map((s) => ({ version: s.version, lines: s.lines.filter((l) => SECURITY.test(l)).map((l) => l.replace(SECURITY, '')) }))
    .filter((s) => s.lines.length > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The released sections a foundation upgrade from `from` to `to` brings in, oldest first. Throws on an unreadable heading. */
export function changesBetween(text, from, to) {
  for (const v of [from, to]) if (parseVersion(v) === null) throw new Error(`"${v}" is not a version number such as 1.2.3.`);
  return parseChangelog(text)
    .filter((s) => s.version !== 'Unreleased' && compareVersions(s.version, from) > 0 && compareVersions(s.version, to) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
// Reads of the foundation never follow a GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE left in Conductor's own environment.
const CLEAN_GIT_ENV = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };

/** The foundation's `vX.Y.Z` release tags, oldest first. Read-only. */
export async function releaseTags(repoDir) {
  const fail = () => new Error(`The foundation repository at ${repoDir} could not be read, so Conductor cannot tell which foundation releases exist.`);
  let r;
  try { r = await git(repoDir, ['tag', '--list', 'v*'], { env: CLEAN_GIT_ENV }); } catch { throw fail(); }
  if (r.code !== 0) throw fail();
  return r.stdout.split('\n').map((t) => t.trim()).filter((t) => RELEASE_TAG.test(t))
    .sort((a, b) => compareVersions(a.slice(1), b.slice(1)));
}

/** The foundation's CHANGELOG.md as it was at release tag `tag`, read without a checkout. */
export async function readChangelogAt(repoDir, tag) {
  const fail = () => new Error(`The foundation's CHANGELOG.md at ${tag} could not be read.`);
  if (typeof tag !== 'string' || !RELEASE_TAG.test(tag)) throw fail();
  let r;
  try { r = await git(repoDir, ['show', `refs/tags/${tag}:CHANGELOG.md`], { env: CLEAN_GIT_ENV }); } catch { throw fail(); }
  if (r.code !== 0) throw fail();
  return r.stdout;
}
