import { spawn } from 'node:child_process';
import { repoPassword } from './config.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the command was stopped because it ran past its time limit. */
  timedOut?: boolean;
}

export interface Runner {
  run(cmd: string, args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult>;
}

const SECRET_KEY = /pass|secret|key|token/i;
const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_STDERR = 256 * 1024;
const KILL_GRACE_MS = 5000;

/**
 * Hides secrets in text a command printed: every value of a secret-looking variable in its environment,
 * and the password part of any address such as rest:https://user:password@host.
 */
export function redact(text: string, env: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_KEY.test(k) && v.length >= 4) out = out.split(v).join('[hidden]');
    // A password written inside an address, such as RESTIC_REPOSITORY=rest:https://user:password@host/repo.
    const inner = repoPassword(v);
    if (inner !== undefined && inner.length >= 4) out = out.split(inner).join('[hidden]');
  }
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:***@');
}

/** Keeps the end of a long output (restic's summary comes last), up to `max` characters. */
function append(buf: string, chunk: string, max: number): string {
  const next = buf + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Runs a program with exactly the environment given (plus PATH and a scratch HOME), collects its output and stops it at the time limit.
 * It never logs its arguments or environment, and hides secrets from the output it returns.
 */
export const execRunner: Runner = {
  run(cmd, args, opts = {}) {
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp', ...(opts.env ?? {}) };
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const done = (r: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killer);
        resolve({ ...r, stdout: redact(r.stdout, env), stderr: redact(r.stderr, env) });
      };
      let killer: NodeJS.Timeout | undefined;
      const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = opts.timeoutMs !== undefined
        ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        }, opts.timeoutMs)
        : undefined;
      child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout = append(stdout, d, MAX_STDOUT); });
      child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr = append(stderr, d, MAX_STDERR); });
      child.on('error', () => {
        done({ code: 127, stdout, stderr: `${cmd} could not be started. Check that it is installed.` });
      });
      child.on('close', (code) => {
        done({ code: code ?? 1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
      });
    });
  },
};
