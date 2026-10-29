// src/factory/projects.js — the client project folder (Contract 1, extended by Contract 7 §7.5).
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './fsAtomic.js';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 40;
export const PROJECT_STATUSES = Object.freeze(['briefing', 'building', 'ready', 'shipped']);

export function validateSlug(slug) {
  if (typeof slug === 'string' && slug.length >= 1 && slug.length <= SLUG_MAX && SLUG_RE.test(slug)) return null;
  return `"${slug}" is not a usable folder name: use 1–40 lower-case letters, digits and single hyphens, e.g. acme-ltd`;
}

export function slugify(text) {
  const s = String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return s;
}

export function projectDir(root, slug) {
  const bad = validateSlug(slug);
  if (bad) throw new Error(bad);
  return path.join(root, slug);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function projectProblem(project, folderSlug) {
  if (!isObj(project)) return 'it is not a JSON object';
  if (project.schema !== 1) return 'schema must be 1';
  if (project.slug !== folderSlug) return `its slug "${project.slug}" does not match its folder "${folderSlug}"`;
  if (typeof project.client !== 'string' || project.client.trim() === '') return 'it has no client name';
  if (!PROJECT_STATUSES.includes(project.status)) return `status must be briefing, building, ready or shipped, not "${project.status}"`;
  const f = project.foundation;
  const bothStrings = isObj(f) && typeof f.repo === 'string' && typeof f.tag === 'string';
  const bothNull = isObj(f) && f.repo === null && f.tag === null;
  if (!bothStrings && !bothNull) return 'foundation must be { repo, tag } (or both null)';
  const a = project.approved;
  if (a !== null && !(isObj(a) && typeof a.sha === 'string' && typeof a.at === 'string' && typeof a.runId === 'string'
    && Number.isInteger(a.briefVersion) && a.briefVersion >= 1)) {
    return 'approved must be null or { sha, at, runId, briefVersion }';
  }
  const b = project.builtFromBrief;
  if (b !== null && !(Number.isInteger(b) && b >= 1)) return 'builtFromBrief must be null or a brief version number';
  return null;
}

export function saveProject(dir, project) {
  const name = path.basename(dir);
  const why = projectProblem(project, name);
  if (why) throw new Error(`Conductor will not save project.json for ${name}: ${why}.`);
  writeJsonAtomic(path.join(dir, 'project.json'), project);
}

export function loadProject(dir) {
  const name = path.basename(dir);
  if (!existsSync(dir)) throw new Error(`There is no project folder at ${dir}.`);
  const file = path.join(dir, 'project.json');
  if (!existsSync(file)) {
    throw new Error(`The folder ${name} has no project.json. It may be a half-made project: remove the folder and run conductor project new again.`);
  }
  let project;
  try { project = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`The project.json in ${name} could not be read (${e.message}).`);
  }
  const why = projectProblem(project, name);
  if (why) throw new Error(`The project.json in ${name} could not be read (${why}).`);
  return project;
}

export function readProject(root, slug) {
  const dir = projectDir(root, slug);
  if (!existsSync(dir)) throw new Error(`There is no project called "${slug}". See your projects with: conductor project list`);
  return { dir, project: loadProject(dir) };
}

export function listProjects(root) {
  let names;
  try { names = readdirSync(root); } catch (e) {
    if (e.code === 'ENOENT') return { projects: [], skipped: 0 };
    throw e;
  }
  const projects = [];
  let skipped = 0;
  for (const name of names.sort()) {
    const full = path.join(root, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { /* vanished */ }
    if (!isDir) continue;
    if (validateSlug(name)) { skipped++; continue; }
    try {
      const { project } = readProject(root, name);
      projects.push({ slug: project.slug, client: project.client, status: project.status, createdAt: project.createdAt, dir: full });
    } catch { skipped++; }
  }
  projects.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { projects, skipped };
}

export function createProject(root, { client, slug, now = new Date() }) {
  const name = String(client ?? '').trim();
  if (name === '') throw new Error('The client name is empty: say who the app is for, e.g. conductor project new "Acme Ltd"');
  if (name.length > 120) throw new Error('The client name is too long: use 120 characters or fewer.');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('The client name has a control character in it: use plain text only.');
  const chosen = slug ?? slugify(name);
  if (chosen === '') throw new Error(`Conductor could not make a folder name from "${name}". Choose one with --slug <name>`);
  const dir = projectDir(root, chosen);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let existing = 'unknown client';
    try { existing = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8')).client || existing; } catch { /* keep fallback */ }
    throw new Error(`A project called ${chosen} already exists (${existing}). Choose another folder name with --slug <name>.`);
  }
  for (const sub of ['brief', 'notes', 'builds', 'deployments']) mkdirSync(path.join(dir, sub), { mode: 0o700 });
  const project = { schema: 1, slug: chosen, client: name, createdAt: now.toISOString(), status: 'briefing',
    foundation: { repo: null, tag: null }, approved: null, builtFromBrief: null };
  saveProject(dir, project);
  return { dir, project };
}
