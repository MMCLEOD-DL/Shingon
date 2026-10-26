import semver from 'semver';

export interface ChangelogSection { version: string; date: string | null; lines: string[] }

const HEADING = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const SECURITY = /^\s*[-*+]\s*\*\*\[\s*security\s*\]\*\*\s*/i;

/** Splits a Keep a Changelog file on its `## [` headings. `Unreleased` comes back as version 'Unreleased'. */
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  for (const chunk of text.split(/^(?=## \[)/m)) {
    const [first = '', ...rest] = chunk.split('\n');
    const m = HEADING.exec(first.trimEnd());
    if (!first.startsWith('## [')) continue; // the title before the first heading
    // Fails closed: a heading that is not understood could hide a security fix, so it stops the check.
    if (!m) throw new Error(`CHANGELOG.md has a heading that is not in the expected form: "${first.trimEnd()}". Use "## [1.2.3] - 2026-01-31" (a two-digit month and day) or "## [Unreleased]".`);
    const version = m[1] ?? '';
    if (version !== 'Unreleased' && semver.valid(version) === null) throw new Error(`CHANGELOG.md has a heading with a version that is not a version number: "${first.trimEnd()}".`);
    sections.push({ version, date: m[2] ?? null, lines: rest.map((l) => l.trimEnd()).filter((l) => l !== '') });
  }
  return sections;
}

/** Released versions newer than `version` that record at least one security fix, newest first, with the marker removed. */
export function securityFixesSince(text: string, version: string): { version: string; lines: string[] }[] {
  if (semver.valid(version) === null) throw new Error(`"${version}" is not a version number such as 1.2.3.`);
  return parseChangelog(text)
    .filter((s) => semver.valid(s.version) !== null && semver.gt(s.version, version))
    .map((s) => ({ version: s.version, lines: s.lines.filter((l) => SECURITY.test(l)).map((l) => l.replace(SECURITY, '')) }))
    .filter((s) => s.lines.length > 0)
    .sort((a, b) => semver.rcompare(a.version, b.version));
}
