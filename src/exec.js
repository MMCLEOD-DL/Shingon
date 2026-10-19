import { spawn } from 'node:child_process';
import { childEnv } from './secrets.js';

export function runCommand({ cmd, args = [], cwd, input = null, timeoutMs = 120000, env } = {}) {
  // Default: the parent env minus SCRUB_ENV keys (see secrets.js). Callers that need a key pass env explicitly.
  env = env ?? childEnv();
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let timer = null, grace = null, child;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    };

    try {
      child = spawn(cmd, args, { cwd, env, detached: true });
    } catch (err) {
      resolve({ stdout, stderr: String(err?.message ?? err), code: -1, timedOut });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
      // a descendant may hold the pipes open after the child dies; force-resolve after a grace period
      grace = setTimeout(() => {
        try { child.stdout?.destroy(); child.stderr?.destroy(); } catch {}
        finish(-1);
      }, 2000);
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += String(err?.message ?? err); finish(-1); });
    child.on('close', (code) => finish(code));

    child.stdin?.on('error', () => {});
    if (input != null) child.stdin?.write(input);
    child.stdin?.end();
  });
}
