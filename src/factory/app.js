// src/factory/app.js -- the client's app: a clone of the foundation at its release tag (Contract 7 §7.11).
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { git as realGit } from '../workspace.js';
import { redact } from '../secrets.js';

export const FOUNDATION_REMOTE = 'foundation';
export const APP_PROFILE_FILE = 'app-profile.json';
const BRAND_FILE = 'apps/web/src/brand.ts';
const BRAND_LINE = /^export const BRAND = \{.*\} as const;$/m;
const SUFFIXES = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'co']);
const CLONE_TIMEOUT_MS = 15 * 60 * 1000;
// workspace.js allows only the file protocol; https is enabled for the one command that needs it (Q19).
const httpsPrefix = (repo) => (String(repo).startsWith('https://') ? ['-c', 'protocol.https.allow=always'] : []);
const firstLine = (s) => redact(String(s ?? '').trim().split('\n')[0] || 'no detail given');

async function run(git, cwd, args, opts) {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${firstLine(r.stderr)}`);
  return r.stdout.trim();
}

function movedTag(tag) {
  return new Error(`The foundation's tag ${tag} now points at a different commit than when this app was made. Conductor will not build on it; ask the foundation's maintainer why the tag moved.`);
}

export async function createApp({ projectDir, foundation, expectCommit = null, git = realGit }) {
  const { repo, tag } = foundation;
  const appDir = path.join(projectDir, 'app');
  const ref = `refs/foundation/${tag}`;

  if (existsSync(appDir)) {
    if ((await git(appDir, ['rev-parse', '--git-dir'])).code !== 0) throw new Error('The app folder exists but is not a git repository, so Conductor stopped. Nothing was changed.');
    const resolve = () => git(appDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    let r = await resolve();
    if (r.code !== 0) {
      const url = (await git(appDir, ['config', '--get', `remote.${FOUNDATION_REMOTE}.url`])).stdout.trim() || repo;
      await run(git, appDir, [...httpsPrefix(url), 'fetch', '-q', '--no-tags', FOUNDATION_REMOTE, `+refs/tags/${tag}:${ref}`], { timeoutMs: CLONE_TIMEOUT_MS });
      r = await resolve();
      if (r.code !== 0) throw new Error(`The foundation has no release ${tag}.`);
    }
    const commit = r.stdout.trim();
    if (expectCommit && commit !== expectCommit) throw movedTag(tag);
    return { appDir, commit, created: false };
  }

  const partial = path.join(projectDir, `app.partial-${randomBytes(3).toString('hex')}`);
  try {
    const c = await git(projectDir, [...httpsPrefix(repo), 'clone', '--quiet', '--no-hardlinks', '--branch', tag, repo, partial], { timeoutMs: CLONE_TIMEOUT_MS });
    if (c.code !== 0) {
      if (/Remote branch .* not found|Could not find remote branch/i.test(c.stderr)) throw new Error(`The foundation has no release ${tag}.`);
      throw new Error(`Conductor could not copy the foundation from ${repo}: ${firstLine(c.stderr)}`);
    }
    const commit = await run(git, partial, ['rev-parse', `${tag}^{commit}`]);
    await run(git, partial, ['checkout', '-q', '-b', 'main']);
    await run(git, partial, ['remote', 'rename', 'origin', FOUNDATION_REMOTE]);
    await run(git, partial, ['config', `remote.${FOUNDATION_REMOTE}.tagOpt`, '--no-tags']);
    await run(git, partial, ['update-ref', ref, commit]);
    const tags = (await run(git, partial, ['for-each-ref', '--format=%(refname)', 'refs/tags'])).split('\n').filter(Boolean);
    for (const t of tags) await run(git, partial, ['update-ref', '-d', t]);
    let info = {};
    try { info = JSON.parse(readFileSync(path.join(partial, 'foundation.json'), 'utf8')); } catch { /* reported below */ }
    if (info.commit !== tag || info.version !== tag.replace(/^v/, '')) {
      const says = info.version !== undefined ? `v${info.version}` : 'nothing usable';
      throw new Error(`The foundation at ${tag} is not a proper release: its foundation.json says ${says}, not ${tag}.`);
    }
    if (expectCommit && commit !== expectCommit) throw movedTag(tag);
    renameSync(partial, appDir);
    return { appDir, commit, created: true };
  } catch (e) {
    rmSync(partial, { recursive: true, force: true });
    throw e;
  }
}

export function initialsOf(client) {
  const words = String(client ?? '').split(/[^A-Za-z]+/).filter((w) => w && !SUFFIXES.has(w.toLowerCase()));
  return words.slice(0, 3).map((w) => w[0].toUpperCase()).join('') || 'App';
}

export function appProfileOf(brief) {
  return { schema: 1, modules: [...brief.modules], policy: { outbound: [...brief.policy.outbound], residency: brief.policy.residency } };
}

export async function nameApp({ appDir, brief, git = realGit }) {
  if ((await run(git, appDir, ['status', '--porcelain'])) !== '') throw new Error('The app folder has changes Conductor did not make, so it stopped. Nothing was changed.');
  const brandPath = path.join(appDir, BRAND_FILE);
  const before = readFileSync(brandPath, 'utf8');
  if (!BRAND_LINE.test(before)) throw new Error("The foundation's apps/web/src/brand.ts does not have the expected BRAND line, so Conductor cannot name the app. Nothing was changed.");
  const line = `export const BRAND = { appName: ${JSON.stringify(brief.client)}, shortName: ${JSON.stringify(initialsOf(brief.client))} } as const;`;
  const after = before.replace(BRAND_LINE, () => line);
  const profilePath = path.join(appDir, APP_PROFILE_FILE);
  const profile = JSON.stringify(appProfileOf(brief), null, 2) + '\n';
  const profileBefore = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : null;
  if (after === before && profile === profileBefore) return null;
  writeFileSync(brandPath, after);
  writeFileSync(profilePath, profile);
  await run(git, appDir, ['add', '--', BRAND_FILE, APP_PROFILE_FILE]);
  await run(git, appDir, ['commit', '-q', '-m', `Name the app: ${brief.client}`]);
  return run(git, appDir, ['rev-parse', 'HEAD']);
}
