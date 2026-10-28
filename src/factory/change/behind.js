// src/factory/change/behind.js — which projects' code and live deployments are behind on foundation [security] fixes.
// Offline and read-only: it reads project.json, the deployment records and the foundation's CHANGELOG.md at its newest
// release tag. It fails closed: anything it cannot read is "could not check: …", never "up to date".
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { releaseTags, readChangelogAt, parseChangelog, securityFixesSince } from '../foundationLog.js';
import { loadProject } from '../projects.js';

const RELEASE_NAME = /^v\d+\.\d+\.\d+$/;
const NO_FOUNDATION_RECORDED = 'could not check: this deployment does not record which foundation release it runs.';
const tidy = (msg) => String(msg).replace(/\s+$/, '');

// One read per foundation repo: { latest, text } or { problem }.
async function readFoundation(repo, read) {
  try {
    const latest = (await read.releaseTags(repo)).at(-1);
    if (!latest) return { problem: 'the foundation has no releases yet.' };
    const text = await read.readChangelogAt(repo, latest);
    parseChangelog(text); // a heading that is not understood could hide a security fix
    return { latest, text };
  } catch (err) {
    return { problem: tidy(err.message) };
  }
}

function judge(slug, where, on, source) {
  const row = { slug, where, on, latest: source.latest ?? null, behind: [], problem: null };
  if (source.problem) return { ...row, problem: `could not check: ${source.problem}` };
  if (typeof on !== 'string' || !RELEASE_NAME.test(on)) return { ...row, problem: `could not check: "${on}" is not a foundation release name.` };
  try {
    return { ...row, behind: securityFixesSince(source.text, on.slice(1)) };
  } catch (err) {
    return { ...row, problem: `could not check: ${tidy(err.message)}` };
  }
}

export async function securityBehind({ projectsRoot, deps, read = { releaseTags, readChangelogAt } }) {
  let names = [];
  try { names = readdirSync(projectsRoot).sort(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const folders = names.filter((n) => existsSync(path.join(projectsRoot, n, 'project.json')));

  let listing = [];
  let listingProblem = null;
  try { listing = deps.listDeployments(projectsRoot); } catch (err) { listingProblem = tidy(err.message); }

  const cache = new Map();
  const sourceFor = (repo) => {
    if (!cache.has(repo)) cache.set(repo, readFoundation(repo, read));
    return cache.get(repo);
  };

  const rows = [];
  for (const folder of folders) {
    let project;
    try { project = loadProject(path.join(projectsRoot, folder)); } catch {
      rows.push({ slug: folder, where: 'code', on: null, latest: null, behind: [], problem: 'could not check: its project.json could not be read.' });
      continue;
    }
    const { repo, tag } = project.foundation;
    const source = repo === null ? { problem: 'this project does not record which foundation it was made from.' } : await sourceFor(repo);
    rows.push(judge(project.slug, 'code', tag, source));
    if (listingProblem) {
      rows.push({ slug: project.slug, where: 'deployments', on: null, latest: null, behind: [], problem: `could not check: ${listingProblem}` });
      continue;
    }
    for (const entry of listing.filter((e) => e.slug === project.slug).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.problem || !entry.deployment) {
        rows.push({ slug: project.slug, where: entry.name, on: null, latest: source.latest ?? null, behind: [], problem: `could not check: ${tidy(entry.problem ?? 'the deployment file could not be read.')}` });
      } else if (!entry.deployment.foundation) {
        rows.push({ slug: project.slug, where: entry.name, on: null, latest: source.latest ?? null, behind: [], problem: NO_FOUNDATION_RECORDED });
      } else {
        rows.push(judge(project.slug, entry.name, entry.deployment.foundation, source));
      }
    }
  }
  return rows;
}

export function behindText(rows) {
  if (rows.length === 0) return 'There are no projects to check.';
  const latests = [...new Set(rows.map((r) => r.latest).filter(Boolean))];
  const out = [];
  if (latests.length > 0) out.push(`Newest foundation release: ${latests.join(', ')}.`, '');
  let slug = null;
  for (const r of rows) {
    if (r.slug !== slug) { out.push(r.slug); slug = r.slug; }
    if (r.problem) { out.push(`  ${r.where}: ${r.problem}`); continue; }
    if (r.behind.length === 0) { out.push(`  ${r.where}: up to date (${r.on})`); continue; }
    const n = r.behind.reduce((sum, b) => sum + b.lines.length, 0);
    out.push(`  ${r.where}: on ${r.on}, missing ${n} security ${n === 1 ? 'fix' : 'fixes'}:`);
    for (const b of r.behind) for (const line of b.lines) out.push(`    - ${line} (${b.version})`);
  }
  out.push('');
  const failed = rows.some((r) => r.problem);
  const behind = rows.some((r) => r.behind.length > 0);
  if (failed) out.push('Some rows could not be checked, so do not assume they are up to date.');
  if (behind) {
    out.push(`To fix: if the code is behind, run "conductor foundation-upgrade <slug> --to ${latests[0]}". If only deployments are behind, the upgrade is already in the code: finish or resume the change that ships it (conductor change <slug> --resume).`);
  } else if (!failed) {
    out.push('Every project and deployment has every security fix in the newest foundation release.');
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n');
}
