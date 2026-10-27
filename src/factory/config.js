// src/factory/config.js — the factory section of the config (Contract 7 §7.1).
// Plan 8 adds the foundation, build and machines sections; unknown keys are refused. Plan 10 adds alerts and ship.
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

export const DEFAULT_PROJECTS_ROOT = '~/highland-projects';

function safeUserName() {
  try { return userInfo().username; } catch { return ''; }
}

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);

function checkKeys(raw, known, where) {
  for (const k of Object.keys(raw)) {
    if (!known.includes(k)) throw new Error(`Unknown setting "${where}.${k}" in the config (known: ${known.join(', ')})`);
  }
}

function objectOf(raw, where) {
  if (raw === undefined) return {};
  if (!isObj(raw)) throw new Error(`${where} must be an object`);
  return raw;
}

function nonEmptyString(v, where) {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where} must be non-empty text`);
  return v;
}

function foundationSection(raw, { home }) {
  const s = objectOf(raw, 'factory.foundation');
  checkKeys(s, ['repo', 'tag'], 'factory.foundation');
  let repo = s.repo ?? '/root/highland-foundation';
  if (typeof repo === 'string') repo = expandHome(repo, home);
  const ok = typeof repo === 'string' && (path.isAbsolute(repo) || /^file:\/\/\S+$/.test(repo) || /^https:\/\/\S+$/.test(repo));
  if (!ok) throw new Error(`factory.foundation.repo must be a local folder, a file:// or an https:// address (got ${JSON.stringify(s.repo)})`);
  const tag = s.tag ?? 'v0.1.0';
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('factory.foundation.tag must be a release tag such as v0.1.0');
  return Object.freeze({ repo, tag });
}

function rounds(v, dflt, max, where) {
  const n = v ?? dflt;
  if (!isInt(n) || n < 0 || n > max) throw new Error(`${where} must be a whole number from 0 to ${max}`);
  return n;
}

function buildSection(raw) {
  const s = objectOf(raw, 'factory.build');
  checkKeys(s, ['testCommand', 'browserGate', 'fixRounds', 'councilFixRounds'], 'factory.build');
  const testCommand = s.testCommand ?? null;
  if (testCommand !== null) nonEmptyString(testCommand, 'factory.build.testCommand');
  const browserGate = s.browserGate ?? true;
  if (typeof browserGate !== 'boolean') throw new Error('factory.build.browserGate must be true or false');
  return Object.freeze({
    testCommand, browserGate,
    fixRounds: rounds(s.fixRounds, 2, 5, 'factory.build.fixRounds'),
    councilFixRounds: rounds(s.councilFixRounds, 3, 10, 'factory.build.councilFixRounds'),
  });
}

function port(v, where) {
  if (!isInt(v) || v < 1 || v > 65535) throw new Error(`${where} must be a whole number from 1 to 65535`);
  return v;
}

function workRootOf(v, where) {
  if (typeof v !== 'string' || !/^\/[A-Za-z0-9/_.-]+$/.test(v)) throw new Error(`${where} must be an absolute path (letters, digits, / _ . -)`);
  return v;
}

function staticHost(h, i, home) {
  const where = `factory.machines.static.hosts[${i}]`;
  if (!isObj(h)) throw new Error(`${where} must be an object`);
  checkKeys(h, ['id', 'name', 'host', 'user', 'keyPath', 'previewPort', 'workRoot'], where);
  if (typeof h.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(h.id)) throw new Error(`${where}.id must be lowercase letters, digits and dashes (up to 31 characters)`);
  if (typeof h.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(h.host)) throw new Error(`${where}: host ${JSON.stringify(h.host)} is not a valid address`);
  const user = h.user ?? 'root';
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error(`${where}.user is not a valid user name`);
  const keyPath = expandHome(nonEmptyString(h.keyPath ?? '~/.ssh/id_ed25519', `${where}.keyPath`), home);
  return Object.freeze({
    id: h.id, name: h.name === undefined ? h.id : nonEmptyString(h.name, `${where}.name`), host: h.host, user, keyPath,
    previewPort: port(h.previewPort ?? 8080, `${where}.previewPort`),
    workRoot: workRootOf(h.workRoot ?? '/srv/hf-factory', `${where}.workRoot`),
  });
}

function proxmoxSection(raw, home) {
  const w = 'factory.machines.proxmox';
  if (!isObj(raw)) throw new Error(`${w} must be an object`);
  checkKeys(raw, ['apiUrl', 'node', 'tokenId', 'tokenEnv', 'caFile', 'pool', 'template', 'vmidRange', 'maxContainers', 'maxMemoryMb',
    'cores', 'memoryMb', 'fullClone', 'user', 'keyPath', 'previewPort', 'workRoot'], w);
  for (const k of ['apiUrl', 'node', 'tokenId', 'pool', 'template', 'vmidRange', 'keyPath']) {
    if (raw[k] === undefined) throw new Error(`${w}.${k} is missing`);
  }
  const apiUrl = raw.apiUrl;
  if (typeof apiUrl !== 'string' || !(/^https:\/\/\S+$/.test(apiUrl) || /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(apiUrl))) {
    throw new Error(`${w}.apiUrl must start with https:// (plain http is only allowed for 127.0.0.1)`);
  }
  nonEmptyString(raw.node, `${w}.node`);
  if (typeof raw.tokenId !== 'string' || !/^[^\s!]+@[^\s!]+![A-Za-z0-9_-]+$/.test(raw.tokenId)) throw new Error(`${w}.tokenId must look like user@realm!tokenname`);
  if (typeof raw.pool !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.pool)) throw new Error(`${w}.pool may only use letters, digits, - and _`);
  const r = raw.vmidRange;
  if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => isInt(n) && n >= 100) || r[0] > r[1]) throw new Error(`${w}.vmidRange must be two whole numbers, lowest first (each 100 or more)`);
  if (!isInt(raw.template) || raw.template < 100) throw new Error(`${w}.template must be a whole number, 100 or more`);
  if (raw.template >= r[0] && raw.template <= r[1]) throw new Error(`${w}.template must not be inside vmidRange`);
  const pos = (v, d, k) => { const n = v ?? d; if (!isInt(n) || n < 1) throw new Error(`${w}.${k} must be a whole number, 1 or more`); return n; };
  const fullClone = raw.fullClone ?? false;
  if (typeof fullClone !== 'boolean') throw new Error(`${w}.fullClone must be true or false`);
  const user = raw.user ?? 'root';
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error(`${w}.user is not a valid user name`);
  return Object.freeze({
    apiUrl, node: raw.node, tokenId: raw.tokenId, tokenEnv: nonEmptyString(raw.tokenEnv ?? 'CONDUCTOR_PROXMOX_TOKEN', `${w}.tokenEnv`),
    caFile: raw.caFile === undefined || raw.caFile === null ? null : expandHome(nonEmptyString(raw.caFile, `${w}.caFile`), home),
    pool: raw.pool, template: raw.template, vmidRange: Object.freeze([r[0], r[1]]),
    maxContainers: pos(raw.maxContainers, 3, 'maxContainers'), maxMemoryMb: pos(raw.maxMemoryMb, 12288, 'maxMemoryMb'),
    cores: pos(raw.cores, 2, 'cores'), memoryMb: pos(raw.memoryMb, 4096, 'memoryMb'), fullClone, user,
    keyPath: expandHome(nonEmptyString(raw.keyPath, `${w}.keyPath`), home),
    previewPort: port(raw.previewPort ?? 80, `${w}.previewPort`),
    workRoot: workRootOf(raw.workRoot ?? '/srv/hf-factory', `${w}.workRoot`),
  });
}

function machinesSection(raw, { home }) {
  const s = objectOf(raw, 'factory.machines');
  checkKeys(s, ['provider', 'sshBin', 'scpBin', 'sweepAfterMs', 'static', 'proxmox'], 'factory.machines');
  const provider = s.provider ?? 'static';
  if (provider !== 'static' && provider !== 'proxmox') throw new Error('factory.machines.provider must be "static" or "proxmox"');
  const sweepAfterMs = s.sweepAfterMs ?? 6 * 3600_000;
  if (!isInt(sweepAfterMs) || sweepAfterMs < 60_000) throw new Error('factory.machines.sweepAfterMs must be a whole number of milliseconds, 60000 or more');
  const st = objectOf(s.static, 'factory.machines.static');
  checkKeys(st, ['hosts'], 'factory.machines.static');
  if (st.hosts !== undefined && !Array.isArray(st.hosts)) throw new Error('factory.machines.static.hosts must be a list');
  const hosts = (st.hosts ?? []).map((h, i) => staticHost(h, i, home));
  const seen = new Set();
  for (const h of hosts) {
    if (seen.has(h.id)) throw new Error(`factory.machines.static.hosts has the id "${h.id}" twice`);
    seen.add(h.id);
  }
  let proxmox = null;
  if (s.proxmox !== undefined && s.proxmox !== null) proxmox = proxmoxSection(s.proxmox, home);
  else if (provider === 'proxmox') throw new Error('factory.machines.proxmox is missing (provider is "proxmox")');
  return Object.freeze({
    provider, sshBin: nonEmptyString(s.sshBin ?? 'ssh', 'factory.machines.sshBin'), scpBin: nonEmptyString(s.scpBin ?? 'scp', 'factory.machines.scpBin'),
    sweepAfterMs, static: Object.freeze({ hosts: Object.freeze(hosts) }), proxmox,
  });
}

const SHIP_DEFAULTS = Object.freeze({ updateTimeoutMs: 2700000, pollMs: 5000, startTimeoutMs: 300000, buildTimeoutMs: 3600000 });

function alertsSection(raw) {
  const s = objectOf(raw, 'factory.alerts');
  checkKeys(s, ['matrix'], 'factory.alerts');
  if (s.matrix === undefined || s.matrix === null) return Object.freeze({ matrix: null });
  const m = objectOf(s.matrix, 'factory.alerts.matrix');
  checkKeys(m, ['homeserver', 'roomId'], 'factory.alerts.matrix');
  if (typeof m.homeserver !== 'string' || !/^https?:\/\/\S+$/.test(m.homeserver)) {
    throw new Error('factory.alerts.matrix.homeserver must be a web address such as https://matrix.example.org.');
  }
  if (typeof m.roomId !== 'string' || !/^![^\s:]+:\S+$/.test(m.roomId)) {
    throw new Error('factory.alerts.matrix.roomId must be a Matrix room id such as !alerts:example.org.');
  }
  return Object.freeze({ matrix: Object.freeze({ homeserver: m.homeserver, roomId: m.roomId }) });
}

function shipSection(raw) {
  const s = objectOf(raw, 'factory.ship');
  checkKeys(s, Object.keys(SHIP_DEFAULTS), 'factory.ship');
  const out = {};
  for (const [k, d] of Object.entries(SHIP_DEFAULTS)) {
    const v = s[k] ?? d;
    if (!isInt(v) || v <= 0) throw new Error(`factory.ship.${k} must be a whole number of milliseconds above 0.`);
    out[k] = v;
  }
  return Object.freeze(out);
}

export function factoryConfig(config, { env = process.env, home = homedir(), user = safeUserName() } = {}) {
  const section = config?.factory ?? {};
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error('the config\'s "factory" section must be an object');
  }
  checkKeys(section, ['projectsRoot', 'operatorName', 'foundation', 'build', 'machines', 'alerts', 'ship'], 'factory');
  const rawRoot = env.CONDUCTOR_PROJECTS_ROOT || section.projectsRoot || DEFAULT_PROJECTS_ROOT;
  const projectsRoot = typeof rawRoot === 'string' ? expandHome(rawRoot, home) : rawRoot;
  if (typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot)) {
    throw new Error(`factory.projectsRoot must be a full path (starting with / or ~), but the config has ${JSON.stringify(rawRoot)}`);
  }
  let operatorName;
  if (section.operatorName === undefined) {
    operatorName = user || 'operator';
  } else {
    const n = section.operatorName;
    if (typeof n !== 'string' || n.trim() === '' || n.length > 80) {
      throw new Error('factory.operatorName must be text (your name, as it should appear on approved briefs)');
    }
    operatorName = n;
  }
  return {
    projectsRoot, operatorName,
    foundation: foundationSection(section.foundation, { home }),
    build: buildSection(section.build),
    machines: machinesSection(section.machines, { home }),
    alerts: alertsSection(section.alerts),
    ship: shipSection(section.ship),
  };
}
