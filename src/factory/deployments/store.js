// src/factory/deployments/store.js — the deployment record (Contract 4) at <projectDir>/deployments/<name>.json.
// It holds only non-secret facts. saveDeployment refuses anything that looks like a secret.
import { mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync, renameSync, linkSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic, createFileExclusive } from '../fsAtomic.js';
import { validateSlug } from '../projects.js';
import { secretValues } from '../../secrets.js';

export const SETUP_STEPS = Object.freeze(['new', 'delivered', 'initialised', 'password-saved', 'configured', 'started', 'verified', 'done']);
export const OUTCOMES = Object.freeze(['installed', 'updated', 'rolled-back', 'cancelled', 'already-on', 'busy', 'settings-error', 'urgent', 'lost-contact', 'confirmed']);

export class DeploymentError extends Error {
  constructor(message) { super(message); this.name = 'DeploymentError'; }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const BUNDLE_RE = /^\/[A-Za-z0-9._/-]+$/;
const REG_HOST_RE = /^[A-Za-z0-9.-]+(:\d+)?$/;
const REG_NS_RE = /^[a-z0-9][a-z0-9._/-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FOUNDATION_RE = /^v\d+\.\d+\.\d+$/;
const SECRET_KEY_RE = /token|password|secret|passphrase|credential|apikey|api_key/i;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';

function validOrigin(origin) {
  if (!isStr(origin)) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== ''
    && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash
    && !origin.endsWith('/');
}

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new DeploymentError(`"${name}" is not a usable deployment name: use 1-40 lower-case letters, digits and hyphens.`);
  }
}

export function deploymentPath(projectDir, name) {
  assertName(name);
  return path.join(projectDir, 'deployments', `${name}.json`);
}

export function validateDeployment(d) {
  const problems = [];
  if (!isObj(d)) return { ok: false, problems: ['The deployment record is not an object.'] };
  if (d.schema !== 1) problems.push('The deployment record schema must be 1.');
  if (!isStr(d.name) || !NAME_RE.test(d.name)) problems.push('The deployment name must be 1-40 lower-case letters, digits and hyphens, starting with a letter or digit.');
  if (!isStr(d.project) || validateSlug(d.project) !== null) problems.push('The project must be a valid project folder name.');
  if (!isStr(d.host) || !HOST_RE.test(d.host)) problems.push('The host must be a hostname, IP address or ssh config alias, and must not start with "-".');
  const ssh = d.ssh;
  if (!isObj(ssh)) problems.push('The ssh settings are missing.');
  else {
    if (!isStr(ssh.user) || !USER_RE.test(ssh.user)) problems.push('The ssh user must be a plain lower-case user name.');
    if (ssh.port !== null && !(Number.isInteger(ssh.port) && ssh.port >= 1 && ssh.port <= 65535)) problems.push('The ssh port must be empty or a whole number from 1 to 65535.');
    if (ssh.keyPath !== null && !(isStr(ssh.keyPath) && path.isAbsolute(ssh.keyPath))) problems.push('The ssh key path must be empty or an absolute path.');
  }
  if (!isStr(d.bundleDir) || !BUNDLE_RE.test(d.bundleDir) || d.bundleDir.split('/').includes('..') || d.bundleDir === '/') {
    problems.push('The bundle folder must be an absolute path made of letters, digits, ".", "_", "-" and "/", with no ".." and not "/".');
  }
  if (!['client-box', 'operator-server'].includes(d.hosting)) problems.push('The hosting must be client-box or operator-server.');
  if (!['tar', 'registry'].includes(d.imageDelivery)) problems.push('The image delivery must be tar or registry.');
  else if (d.imageDelivery === 'registry') {
    const r = d.registry;
    if (!isObj(r) || !isStr(r.host) || !REG_HOST_RE.test(r.host) || !isStr(r.namespace) || !REG_NS_RE.test(r.namespace) || !isStr(r.user) || r.user === '') {
      problems.push('With registry image delivery, the registry needs a host, a namespace and a user.');
    }
  } else if (d.registry !== null) problems.push('The registry must be empty unless images are delivered through a registry.');
  if (!['cloudflare-tunnel', 'ssh', 'tailscale'].includes(d.access)) problems.push('The access must be cloudflare-tunnel, ssh or tailscale.');
  if (!validOrigin(d.origin)) problems.push('The origin must look like https://host or http://host:port, with no path, query or login.');
  if (!isStr(d.site) || d.site === '') problems.push('The site address must not be empty.');
  else if (d.access === 'cloudflare-tunnel' && d.site !== ':80') problems.push('With a Cloudflare tunnel the site address must be :80.');
  if (!isObj(d.setup) || !SETUP_STEPS.includes(d.setup.step)) problems.push(`The setup step must be one of: ${SETUP_STEPS.join(', ')}.`);
  if (d.currentVersion !== null && !(isStr(d.currentVersion) && VERSION_RE.test(d.currentVersion))) problems.push('The current version must be empty or like 1.2.3.');
  if (d.foundation !== null && !(isStr(d.foundation) && FOUNDATION_RE.test(d.foundation))) problems.push('The foundation version must be empty or like v1.2.3 (with the "v").');
  if (!Array.isArray(d.history)) problems.push('The history must be a list.');
  else {
    d.history.forEach((h, i) => {
      if (!isObj(h) || !OUTCOMES.includes(h.outcome)) problems.push(`History entry ${i + 1} has an outcome that is not one of: ${OUTCOMES.join(', ')}.`);
    });
  }
  return { ok: problems.length === 0, problems };
}

export function newDeployment(fields) {
  const d = {
    schema: 1,
    ...fields,
    setup: { step: 'new', at: null },
    currentVersion: null,
    foundation: null,
    bundleVersion: null,
    pendingCheck: null,
    lastStatus: null,
    history: [],
  };
  if (d.registry === undefined) d.registry = null;
  const r = validateDeployment(d);
  if (!r.ok) throw new DeploymentError(`The deployment record is not valid: ${r.problems.join(' ')}`);
  return d;
}

// Returns the dotted path of the first secret-looking key or value, or null.
function findSecret(x, secrets, trail = []) {
  if (isStr(x)) return secrets.some((s) => x.includes(s)) ? trail.slice(0, -1).join('.') || '(top level)' : null;
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) {
      const hit = findSecret(x[i], secrets, [...trail, String(i)]);
      if (hit !== null) return hit;
    }
  } else if (isObj(x)) {
    for (const [k, v] of Object.entries(x)) {
      if (SECRET_KEY_RE.test(k)) return trail.join('.') || '(top level)';
      const hit = findSecret(v, secrets, [...trail, k]);
      if (hit !== null) return hit;
    }
  }
  return null;
}

export function saveDeployment(projectDir, dep) {
  const r = validateDeployment(dep);
  if (!r.ok) throw new DeploymentError(`The deployment record was not saved because it is not valid: ${r.problems.join(' ')}`);
  const where = findSecret(dep, secretValues());
  if (where !== null) {
    throw new DeploymentError(`The deployment record for ${dep.name} was not saved because it would have held a secret (in ${where}). This is a bug in Conductor; nothing was written.`);
  }
  mkdirSync(path.join(projectDir, 'deployments'), { recursive: true });
  writeJsonAtomic(deploymentPath(projectDir, dep.name), dep, { mode: 0o644 });
}

function readRecord(file) {
  const stem = path.basename(file, '.json');
  let dep;
  try { dep = JSON.parse(readFileSync(file, 'utf8')); } catch (err) {
    throw new DeploymentError(`The deployment record ${file} could not be read (${err.message}). Fix or remove it.`);
  }
  const r = validateDeployment(dep);
  if (!r.ok) throw new DeploymentError(`The deployment record ${file} could not be read (${r.problems[0]}). Fix or remove it.`);
  if (dep.name !== stem) throw new DeploymentError(`The deployment record ${file} could not be read (it is named "${dep.name}" inside but "${stem}" on disk). Fix or remove it.`);
  return dep;
}

export function loadDeployment(projectDir, name) {
  const file = deploymentPath(projectDir, name);
  if (!existsSync(file)) return null;
  return readRecord(file);
}

export function listDeployments(root, { slug = null } = {}) {
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  const slugs = dirs.filter((e) => e.isDirectory() && validateSlug(e.name) === null && (slug === null || e.name === slug))
    .map((e) => e.name).sort();
  for (const s of slugs) {
    const projectDir = path.join(root, s);
    let files;
    try { files = readdirSync(path.join(projectDir, 'deployments')).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
    for (const f of files) {
      const name = f.slice(0, -'.json'.length);
      try {
        out.push({ slug: s, projectDir, name, deployment: readRecord(path.join(projectDir, 'deployments', f)), problem: null });
      } catch (err) {
        if (!(err instanceof DeploymentError)) throw err;
        out.push({ slug: s, projectDir, name, deployment: null, problem: err.message });
      }
    }
  }
  return out;
}

export function addHistory(dep, { version, from = null, outcome, detail = '', at }) {
  if (!OUTCOMES.includes(outcome)) throw new DeploymentError(`"${outcome}" is not a known update outcome.`);
  return { ...dep, history: [...dep.history, { at, version, from, outcome, detail }] };
}

export function withStep(dep, step, at) {
  if (!SETUP_STEPS.includes(step)) throw new DeploymentError(`"${step}" is not a known setup step.`);
  return { ...dep, setup: { step, at } };
}

export function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
}

// Same shape as projectLock.js: a dead lock is renamed aside (only one taker can win the rename),
// the moved bytes are checked against what was judged dead, then the winner creates the lock exclusively.
export function lockDeployment(projectDir, name, { pid = process.pid, isAlive = defaultIsAlive, beforeTakeover = () => {} } = {}) {
  assertName(name);
  mkdirSync(path.join(projectDir, 'deployments'), { recursive: true });
  const file = path.join(projectDir, 'deployments', `${name}.lock`);
  const body = () => JSON.stringify({ pid, at: new Date().toISOString() }) + '\n';
  for (let attempt = 0; ; attempt++) {
    try {
      createFileExclusive(file, body());
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let seen = null;
      try { seen = readFileSync(file, 'utf8'); } catch { /* vanished: retry */ }
      let holder = null;
      try { holder = JSON.parse(seen); } catch { /* unreadable or corrupt: counts as dead */ }
      if (holder && Number.isInteger(holder.pid) && isAlive(holder.pid)) return null;
      if (attempt >= 2) return null;
      if (seen === null) continue;
      beforeTakeover();
      const aside = `${file}.stale-${pid}-${randomBytes(6).toString('hex')}`;
      try { renameSync(file, aside); } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
      let moved = null;
      try { moved = readFileSync(aside, 'utf8'); } catch { /* treat as changed */ }
      if (moved !== seen) {
        // Another taker got in between: put their lock back and report busy.
        try { linkSync(aside, file); } catch { /* a third starter already holds it */ }
        rmSync(aside, { force: true });
        return null;
      }
      rmSync(aside, { force: true });
    }
  }
  return {
    release() {
      try {
        if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) unlinkSync(file);
      } catch { /* already gone */ }
    },
  };
}
