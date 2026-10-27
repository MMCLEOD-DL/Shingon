// Port of the foundation's scripts/changelog.ts (securityFixesSince) for a zero-dependency Conductor.
// `semver` is replaced by parseVersion/compareVersions below (strict: no leading 'v' or '=').
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
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
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
