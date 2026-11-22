import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { strictChildEnv, secretValues, redact, SCRUB_ENV, REDACT_ENV } from '../secrets.js';

export function workerOutput(value) {
  return redact(String(value ?? ''))
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n').split('\n').slice(-8).join('\n').slice(-600);
}

export async function workerReady(url, { signal, timeoutMs = 2000 } = {}) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]) : AbortSignal.timeout(Math.max(1, timeoutMs)) });
    const ready = response.status === 200;
    // A body/cancellation error cannot turn an observed 200 into permission to
    // start again. The response content is never read or projected.
    void response.body?.cancel().catch(() => {});
    return ready;
  } catch { return false; }
}

export function launchWorkerCommand(config, { signal } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ cancelled: true }); return; }
    const env = strictChildEnv(), redactions = secretValues();
    const privateNames = new Set([...SCRUB_ENV, ...REDACT_ENV].map(name => name.toUpperCase()));
    for (const [name, value] of Object.entries(process.env)) {
      if (!privateNames.has(name.toUpperCase())) continue;
      delete env[name];
      if (typeof value === 'string' && value.length >= 8) redactions.push(value);
    }
    const child = fork(fileURLToPath(new URL('./localWorkerLauncher.js', import.meta.url)), ['--local-worker-launcher'], {
      detached: true, windowsHide: true, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    });
    child.unref(); child.channel?.unref();
    let done = false, launched = false, timer;
    const finish = result => {
      if (done) return; done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (child.connected) child.disconnect();
      resolve(result);
    };
    const abort = () => finish({ cancelled: true });
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish({ code: -1, output: 'The configured start command could not be launched.' }));
    const startupDeadline = performance.now() + 5000;
    child.on('message', msg => {
      if (done) return;
      if (msg?.type === 'ready' && !launched) {
        if (performance.now() >= startupDeadline) { finish({ code: -1, output: 'The start launcher did not become available within its deadline.' }); return; }
        launched = true; clearTimeout(timer);
        timer = setTimeout(() => finish({ code: -1, output: 'The start launcher did not report an outcome within its deadline.' }), 35000);
        // Only the trusted launcher receives redaction strings over private IPC.
        // The configured command inherits the strict, credential-free environment.
        child.send({ type: 'launch', command: config.startCommand, timeoutMs: 30000, redactions });
      } else if (msg?.type === 'finished' && launched) finish({ code: msg.code, output: workerOutput(msg.output), timedOut: msg.timedOut });
    });
    child.on('exit', () => finish({ code: -1, output: 'The start launcher stopped before reporting an outcome.' }));
    timer = setTimeout(() => finish({ code: -1, output: 'The start launcher did not become available within its deadline.' }), 5000);
  });
}

export function waitDelay(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function localWorkerTools(overrides = {}) {
  return { ready: workerReady, launch: launchWorkerCommand, sleep: waitDelay, now: () => performance.now(), ...overrides };
}
