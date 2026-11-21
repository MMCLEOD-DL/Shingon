// Run one checker process: no shell, a hidden window, a bounded time and clipped output.
import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 4000;

// Model-written code runs under these commands, so the child gets only what it needs to find programs and a temp
// folder: no keys, tokens or other variables from the operator's shell.
const KEEP_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG'];

export function checkerEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (KEEP_ENV.includes(k.toUpperCase())) out[k] = v;
  return out;
}

export function runProcess(cmd, args, { cwd, timeoutMs = 60000, env = checkerEnv() } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let output = '';
    let timedOut = false;
    const add = (chunk) => { if (output.length < OUTPUT_LIMIT) output = (output + chunk).slice(0, OUTPUT_LIMIT); };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, timedOut: false, output: String(e.message), ms: 0, spawnError: true });
      return;
    }
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const done = (code, spawnError = false, extra = '') => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ code, timedOut, output: output + extra, ms: Math.round(ms), spawnError });
    };
    child.on('error', (e) => done(null, true, String(e.message)));
    child.on('close', (code) => done(code));
  });
}
