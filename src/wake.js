// src/wake.js
// Waking a worker before a run (factory spec §4.2). Warn-only unless the config asks.

import dgram from 'node:dgram';
import { runCommand } from './exec.js';
import { strictChildEnv, redact, secretValues } from './secrets.js';
import { summarizeFailure } from './health.js';

export const WAKE_DEFAULTS = Object.freeze({ method: 'warn', waitMs: 180000, pollMs: 5000, broadcast: '255.255.255.255', port: 9, timeoutMs: 60000 });
export const DEFAULT_WAKE_HINT = 'Start the machine that runs this model, and its model server, then try again.';

const METHODS = ['warn', 'wol', 'command'];
const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Every message names the participant and the setting, never a value read from the environment.
function fail(name, text) {
  throw new Error(`Participant ${name}: ${text}`);
}

function wholeMs(raw, key, min, max, name) {
  const v = raw[key] ?? WAKE_DEFAULTS[key];
  if (!Number.isInteger(v) || v < min || v > max) fail(name, `wake.${key} must be a whole number of milliseconds from ${min} to ${max}`);
  return v;
}

export function normalizeWake(raw, participantName) {
  const name = participantName;
  if (raw == null) return Object.freeze({ method: 'warn', hint: DEFAULT_WAKE_HINT, waitMs: WAKE_DEFAULTS.waitMs, pollMs: WAKE_DEFAULTS.pollMs });
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(name, 'wake must be an object');
  const method = raw.method ?? WAKE_DEFAULTS.method;
  if (!METHODS.includes(method)) fail(name, 'wake.method must be "warn", "wol" or "command"');
  // Built from scratch, not spread from raw: keys that belong to another method drop out.
  const out = {
    method,
    hint: typeof raw.hint === 'string' && raw.hint.trim() ? raw.hint.trim() : DEFAULT_WAKE_HINT,
    waitMs: wholeMs(raw, 'waitMs', 0, 900000, name),
    pollMs: wholeMs(raw, 'pollMs', 500, 60000, name),
  };
  if (method === 'wol') {
    if (typeof raw.mac !== 'string' || !MAC.test(raw.mac)) fail(name, 'wake.mac must be a network card address such as "aa:bb:cc:dd:ee:ff"');
    out.mac = raw.mac.toLowerCase().replaceAll('-', ':');
    const broadcast = raw.broadcast ?? WAKE_DEFAULTS.broadcast;
    if (typeof broadcast !== 'string' || !broadcast.trim()) fail(name, 'wake.broadcast must be an address such as "192.168.1.255"');
    out.broadcast = broadcast.trim();
    const port = raw.port ?? WAKE_DEFAULTS.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(name, 'wake.port must be a whole number from 1 to 65535');
    out.port = port;
  } else if (method === 'command') {
    if (typeof raw.cmd !== 'string' || !raw.cmd.trim()) fail(name, 'wake.cmd must name the program to run');
    out.cmd = raw.cmd;
    const args = raw.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) fail(name, 'wake.args must be a list of words, such as ["-i", "/path/to/key", "wake@192.168.1.109"]');
    out.args = Object.freeze([...args]);
    const env = raw.env ?? [];
    if (!Array.isArray(env) || !env.every((n) => typeof n === 'string' && ENV_NAME.test(n))) fail(name, 'wake.env must be a list of environment variable names, such as ["WAKE_TOKEN"]');
    out.env = Object.freeze([...env]);
    out.timeoutMs = wholeMs(raw, 'timeoutMs', 1000, 600000, name);
  }
  return Object.freeze(out);
}

export const WAKE_METHOD_TEXT = Object.freeze({ warn: 'none set up', wol: 'Wake-on-LAN', command: 'its start command' });

// Six 0xff bytes, then the six MAC bytes sixteen times: 102 bytes.
export function magicPacket(mac) {
  const bytes = Buffer.from(String(mac).replace(/[:-]/g, ''), 'hex');
  if (bytes.length !== 6) throw new Error('a network card address has six bytes');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

export function sendMagicPacket({ mac, broadcast = WAKE_DEFAULTS.broadcast, port = WAKE_DEFAULTS.port }, { createSocket = dgram.createSocket } = {}) {
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    let socket = null;
    let settled = false;
    // Settles exactly once and closes the socket on every path.
    const done = (err) => {
      if (settled) return;
      settled = true;
      try { socket?.close(); } catch {}
      if (err) reject(err);
      else resolve();
    };
    try {
      socket = createSocket('udp4');
      socket.once('error', done);
      socket.once('listening', () => {
        try {
          socket.setBroadcast(true);
          socket.send(packet, port, broadcast, (err) => done(err ?? null));
        } catch (e) {
          done(e);
        }
      });
      socket.bind();
    } catch (e) {
      done(e);
    }
  });
}

// The operator's own start program: no secret-looking variables except the ones the block names,
// output summarized and redacted (Review Focus 4), killed after timeoutMs.
export async function runWakeCommand(wake, { run = runCommand, env = process.env } = {}) {
  const picked = {};
  for (const name of wake.env ?? []) if (typeof env[name] === 'string') picked[name] = env[name];
  const childEnv = { ...strictChildEnv({ env }), ...picked };
  // Every named value is a secret, even when its name does not look like one.
  const named = Object.values(picked).filter((v) => v.length > 0);
  const secrets = [...new Set([...secretValues(env), ...named])].sort((a, b) => b.length - a.length);
  const timeoutMs = wake.timeoutMs ?? WAKE_DEFAULTS.timeoutMs;
  const r = await run({ cmd: wake.cmd, args: [...(wake.args ?? [])], env: childEnv, timeoutMs });
  const ok = r.code === 0 && !r.timedOut;
  let detail = '';
  if (r.timedOut) detail = `its start command did not finish within ${Math.round(timeoutMs / 1000)} seconds`;
  else if (!ok) detail = `its start command failed: ${summarizeFailure(r.stderr || r.stdout) || `exit code ${r.code}`}`;
  return { ok, detail: redact(detail, secrets) };
}

// Sends the wake and reports what happened; never waits for the worker (readiness does) and never throws.
export async function wakeWorker(participant, { send = sendMagicPacket, runCmd = runWakeCommand } = {}) {
  const wake = participant.wake ?? normalizeWake(null, participant.name);
  if (wake.method === 'wol') {
    try {
      await send(wake);
      return { attempted: true, ok: true, detail: 'sent a Wake-on-LAN signal' };
    } catch (e) {
      return { attempted: true, ok: false, detail: `could not send the Wake-on-LAN signal (${e?.code ?? e?.message ?? e})` };
    }
  }
  if (wake.method === 'command') {
    try {
      const r = await runCmd(wake);
      return r?.ok === true
        ? { attempted: true, ok: true, detail: 'ran its start command' }
        : { attempted: true, ok: false, detail: r?.detail || 'its start command failed' };
    } catch (e) {
      return { attempted: true, ok: false, detail: redact(`its start command failed: ${e?.message ?? e}`) };
    }
  }
  return { attempted: false, ok: false, detail: '' };
}
