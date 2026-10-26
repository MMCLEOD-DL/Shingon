import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseChangelog } from './changelog.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

export type Bump = 'patch' | 'minor' | 'major';

/** Moves the Unreleased entries under a new dated version and leaves an empty Unreleased section. */
export function planRelease(changelog: string, current: string, bump: Bump, today: string): { version: string; changelog: string } {
  const parts = changelog.split(/^(?=## \[)/m);
  const at = parts.findIndex((p) => /^## \[Unreleased\]/.test(p));
  const body = at < 0 ? '' : (parts[at] ?? '').split('\n').slice(1).join('\n').trim();
  if (body === '') throw new Error('There is nothing under "Unreleased" in CHANGELOG.md, so there is nothing to release.');
  const version = semver.inc(current, bump);
  if (version === null) throw new Error(`"${current}" is not a version number such as 1.2.3, so it cannot be raised.`);
  const before = parts.slice(0, at).join('');
  const after = parts.slice(at + 1).join('');
  const released = `## [${version}] - ${today}\n${body}\n`;
  return { version, changelog: `${before}## [Unreleased]\n\n${released}${after === '' ? '' : `\n${after}`}` };
}

export interface AuditResult { code: number | null; stdout: string }
export type AuditOutcome = { ok: true } | { ok: false; reason: 'unavailable' | 'vulnerable'; message: string };

export const AUDIT_UNAVAILABLE =
  'Could not check for known security problems (npm audit did not run), so the release has been stopped. Check the internet connection and try again.';

/** Reads `npm audit --omit=dev --audit-level=high --json`. Anything unreadable counts as "did not run": the check fails closed. */
export function judgeAudit(res: AuditResult): AuditOutcome {
  const unavailable: AuditOutcome = { ok: false, reason: 'unavailable', message: AUDIT_UNAVAILABLE };
  let j: unknown;
  try {
    j = JSON.parse(res.stdout);
  } catch {
    return unavailable;
  }
  const o = (typeof j === 'object' && j !== null ? j : {}) as { error?: unknown; vulnerabilities?: unknown };
  if (o.error !== undefined || typeof o.vulnerabilities !== 'object' || o.vulnerabilities === null) return unavailable;
  const bad = Object.entries(o.vulnerabilities as Record<string, { severity?: string }>)
    .filter(([, v]) => v.severity === 'high' || v.severity === 'critical')
    .map(([name]) => name)
    .sort();
  if (bad.length === 0) return { ok: true };
  const n = bad.length;
  return {
    ok: false,
    reason: 'vulnerable',
    message: `${String(n)} shipped ${n === 1 ? 'package has' : 'packages have'} known high-severity security problems (${bad.join(', ')}). Update ${n === 1 ? 'it' : 'them'}, or record why each does not apply in CHANGELOG.md, before releasing.`,
  };
}

interface JsonFile { version?: string; commit?: string; packages?: Record<string, { version?: string } | undefined> }

export interface ReleaseDeps {
  root: string;
  today: string;
  isClean(): boolean;
  audit(): AuditResult;
  /** True when git knows who is committing (user.name and user.email). */
  hasGitIdentity(): boolean;
  tagExists(tag: string): boolean;
  commitAndTag(version: string): void;
}

/** Does the whole release except pushing. Throws plain-English problems. */
export function runRelease(bump: Bump, deps: ReleaseDeps): string {
  if (!deps.isClean()) throw new Error('Commit or stash your changes first.');
  const verdict = judgeAudit(deps.audit());
  if (!verdict.ok) throw new Error(verdict.message);
  const file = (f: string): string => path.join(deps.root, f);
  const pkg = JSON.parse(readFileSync(file('package.json'), 'utf8')) as { version: string };
  const found = JSON.parse(readFileSync(file('foundation.json'), 'utf8')) as JsonFile;
  if (found.version !== pkg.version) {
    throw new Error(`foundation.json says ${String(found.version)} but package.json says ${pkg.version}. They must match before a release; fix whichever is wrong.`);
  }
  const changelog = readFileSync(file('CHANGELOG.md'), 'utf8');
  const plan = planRelease(changelog, pkg.version, bump, deps.today);
  if (parseChangelog(changelog).some((s) => s.version === plan.version)) {
    throw new Error(`CHANGELOG.md already has a section for ${plan.version}. Fix the changelog or the version before releasing.`);
  }
  if (deps.tagExists(`v${plan.version}`)) throw new Error(`The tag v${plan.version} already exists, so this release would overwrite it. Remove the tag if it is a mistake, or choose a different kind of release.`);
  if (!deps.hasGitIdentity()) throw new Error('Git does not know who you are. Set it with git config user.name and git config user.email, then try again.');
  const setVersion = (f: string, edit: (j: JsonFile) => void): void => {
    const j = JSON.parse(readFileSync(file(f), 'utf8')) as JsonFile;
    edit(j);
    writeFileSync(file(f), `${JSON.stringify(j, null, 2)}\n`);
  };
  writeFileSync(file('CHANGELOG.md'), plan.changelog);
  setVersion('package.json', (j) => { j.version = plan.version; });
  try {
    setVersion('package-lock.json', (j) => {
      j.version = plan.version;
      const top = j.packages?.[''];
      if (top) top.version = plan.version;
    });
  } catch (err) {
    // No lock file means nothing to keep in step; any other problem must not be hidden.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // The release commit's own sha cannot be known before the commit exists, so the stamp records the tag name.
  setVersion('foundation.json', (j) => { j.version = plan.version; j.commit = `v${plan.version}`; });
  deps.commitAndTag(plan.version);
  return plan.version;
}

function realDeps(root: string): ReleaseDeps {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  return {
    root,
    today: new Date().toISOString().slice(0, 10),
    isClean: () => git('status', '--porcelain').trim() === '',
    audit() {
      const r = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return { code: r.status, stdout: r.stdout };
    },
    hasGitIdentity() {
      try { return git('config', 'user.name').trim() !== '' && git('config', 'user.email').trim() !== ''; } catch { return false; }
    },
    tagExists(tag) {
      try { return git('tag', '--list', tag).trim() !== ''; } catch { return false; }
    },
    commitAndTag(version) {
      const step = (what: string, ...args: string[]): void => {
        try { git(...args); } catch {
          throw new Error(`Git could not ${what}. The release files have been changed but not finished: check "git status", then undo them with "git checkout ." or finish by hand.`);
        }
      };
      step('add the release files', 'add', '-A', 'CHANGELOG.md', 'package.json', 'foundation.json', ...(existsSync(path.join(root, 'package-lock.json')) ? ['package-lock.json'] : []));
      step('make the release commit', 'commit', '-m', `release: v${version}`);
      step('create the release tag', 'tag', '-a', `v${version}`, '-m', `v${version}`);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const bump = process.argv[2];
    if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') throw new Error('Say which kind of release this is: patch, minor or major. For example: npx tsx scripts/release.ts minor');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const version = runRelease(bump, realDeps(root));
    console.log(`Released v${version} on this machine. Nothing has been pushed: when you are happy, run "git push --follow-tags".`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
