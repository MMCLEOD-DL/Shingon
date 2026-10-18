// src/exec.js
import { spawn } from 'node:child_process';

export function runCommand({ cmd, args = [], cwd, input = null, timeoutMs = 120000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (err) {
      resolve({ stdout, stderr: String(err?.message ?? err), code: -1, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err?.message ?? err), code: -1, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    });

    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}
