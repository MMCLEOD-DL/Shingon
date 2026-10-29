import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { atomicJson, requireValue } from './state.js';
import { loadConfig } from '../config.js';

const SUPPORTED = new Set(['claude-code', 'codex', 'local-agent']);
export function readSetup(file) {
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { participants: [], routing: { allowApi: false } };
  requireValue(raw && Array.isArray(raw.participants), 'The configured Conductor file is invalid.');
  return raw;
}
function publicEndpoint(value) {
  try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash ? u.href : null; } catch { return null; }
}
export function sanitizedSetup(file) {
  const raw = readSetup(file);
  return { configured: raw.participants.length > 0,
    participants: raw.participants.map(p => ({ participantId: p.name, adapter: p.adapter,
      model: p.model ?? null, executable: 'unknown', authentication: 'unknown', endpoint: 'unknown',
      agenticExecution: 'unknown', checkedAt: null, probeKind: 'installation', reason: null, action: null })),
    local: (() => { const p = raw.participants.find(p => p.adapter === 'local-agent'); return p ? { model: p.model ?? null, baseUrl: publicEndpoint(p.baseUrl) } : null; })(),
    presets: [{ id: 'default', label: 'Configured repository checks', testCommand: raw.options?.testCommand ?? null }],
    routing: { local: raw.routing?.local ?? null, author: raw.routing?.author ?? null, reviewer: raw.routing?.reviewer ?? null, allowApi: false },
    apiDisabled: true };
}
export function validateSetup(body) {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'Settings must be an object.');
  requireValue(Object.keys(body).every(k => ['local', 'routing'].includes(k)), 'Only local model and routing settings can be changed in the browser.');
  if (body.local !== undefined) {
    requireValue(body.local && Object.keys(body.local).every(k => ['baseUrl', 'model'].includes(k)), 'Invalid local model settings.');
    requireValue(typeof body.local.model === 'string' && body.local.model.trim().length > 0 && body.local.model.length <= 200, 'Enter the installed local model name.');
    let u;
    try { u = new URL(body.local.baseUrl); } catch { /* validation below */ }
    requireValue(u && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash, 'Use a model endpoint without credentials, a query or fragment.');
    requireValue(u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname), 'Remote model endpoints must use HTTPS or an existing local secure route.');
  }
  if (body.routing !== undefined) requireValue(body.routing && Object.keys(body.routing).every(k => ['local', 'author', 'reviewer'].includes(k))
    && Object.values(body.routing).every(v => typeof v === 'string' && /^[\w-]{1,80}$/.test(v)), 'Invalid participant selection.');
  return { valid: true };
}
export function saveSetup(file, body) {
  validateSetup(body);
  if (existsSync(file)) requireValue(!lstatSync(file).isSymbolicLink(), 'Edit linked configuration through its owner; it will not be overwritten.');
  const raw = readSetup(file);
  if (!raw.participants.length) {
    requireValue(body.local, 'Configure the local model first.');
    raw.participants = [
      ...['claude-code', 'codex'].map((adapter, i) => ({ name: i ? 'codex' : 'claude', adapter, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } })),
      { name: 'local', adapter: 'local-agent', roles: ['grunt'], capabilities: { is_agentic: true, can_edit_files: true } },
    ];
  }
  if (body.local) {
    const local = raw.participants.find(p => p.name === (body.routing?.local ?? raw.routing?.local ?? 'local'))
      ?? raw.participants.find(p => p.adapter === 'local-agent');
    requireValue(local?.adapter === 'local-agent', 'Select a configured local-agent participant.');
    Object.assign(local, { baseUrl: body.local.baseUrl, model: body.local.model.trim() });
  }
  raw.routing = { ...raw.routing, ...body.routing, allowApi: false, localDown: 'ask' };
  for (const [key, value] of Object.entries(body.routing ?? {})) {
    requireValue(raw.participants.some(p => p.name === value && (key === 'local' ? p.adapter === 'local-agent' : ['claude-code', 'codex'].includes(p.adapter))), 'Select a participant with the appropriate role.');
  }
  // Refuse unknown/ad-hoc adapters, but preserve unrelated user fields/configuration.
  requireValue(raw.participants.every(p => SUPPORTED.has(p.adapter)), 'The local app supports subscription CLIs and a local-agent only. Keep API configurations in the CLI.');
  atomicJson(file, raw);
  return sanitizedSetup(file);
}
export function appConfig(file) {
  const raw = readSetup(file);
  requireValue(raw.participants.length && raw.participants.every(p => SUPPORTED.has(p.adapter)), 'Configure the subscription CLIs and local model first.', 'setup-required', 409);
  const config = loadConfig(file);
  config.routing = { ...config.routing, allowApi: false, localDown: 'ask' };
  return config;
}
