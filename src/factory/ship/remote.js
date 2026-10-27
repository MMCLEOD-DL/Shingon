// Everything Plan 10 does on a client box or a build machine goes through here: a safe ssh command line,
// a remote command (optionally fed standard input), a streamed copy between machines, and plain-English failures.
// Quoting and validation are Plan 8's (assertSafe, shQuote); this file has none of its own.
import { createReadStream } from 'node:fs';
import { runCommand, spawnTracked } from '../../exec.js';
import { strictChildEnv, redact } from '../../secrets.js';
import { findBin } from '../../council/tools.js';
import { assertSafe } from '../remote.js';

export function missingTools(names, { env = process.env } = {}) {
  return names.filter((n) => !findBin(n, { env }));
}

export function targetOf(dep) {
  return { host: dep.host, user: dep.ssh?.user, port: dep.ssh?.port ?? null, keyPath: dep.ssh?.keyPath ?? null,
    knownHostsFile: null, hostKeyPolicy: 'yes', label: dep.name };
}

export function targetOfMachine(machine) {
  return { host: machine.host, user: machine.ssh?.user, port: null, keyPath: machine.ssh?.keyPath ?? null,
    knownHostsFile: machine.ssh?.knownHostsFile ?? null, hostKeyPolicy: machine.ssh?.hostKeyPolicy,
    label: `the build machine (${machine.host})` };
}

const WHAT = { host: 'host name', user: 'user name', port: 'port', path: 'key file' };

export function targetProblem(t) {
  const bad = (kind) => `Conductor will not connect to "${t?.host}": it does not look like a ${WHAT[kind]}.`;
  const check = (kind, value) => { try { assertSafe(kind, value); return null; } catch { return bad(kind); } };
  return check('host', t?.host)
    ?? (String(t.host).startsWith('-') ? bad('host') : null)
    ?? check('user', t.user)
    ?? (t.port != null ? check('port', t.port) : null)
    ?? (t.keyPath ? check('path', t.keyPath) : null)
    ?? (t.knownHostsFile ? check('path', t.knownHostsFile) : null)
    ?? (['yes', 'accept-new'].includes(t.hostKeyPolicy ?? 'yes') ? null : bad('host'));
}

export function sshArgs(t, command) {
  return ['-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${t.hostKeyPolicy ?? 'yes'}`, '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
    ...(t.knownHostsFile ? ['-o', `UserKnownHostsFile=${t.knownHostsFile}`] : []),
    ...(t.port ? ['-p', String(t.port)] : []),
    ...(t.keyPath ? ['-i', t.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    '-l', t.user, '--', t.host, command];
}

function sshEnv(env) {
  const out = strictChildEnv({ env });
  if (env?.SSH_AUTH_SOCK) out.SSH_AUTH_SOCK = env.SSH_AUTH_SOCK; // not secret; copied explicitly so agent auth survives filter changes
  return out;
}

export async function remoteRun(t, command, { input = null, timeoutMs = 120000, env = process.env } = {}) {
  const problem = targetProblem(t);
  if (problem) return { code: -1, stdout: '', stderr: problem, timedOut: false, unreachable: true };
  const ssh = findBin('ssh', { env });
  if (!ssh) return { code: -1, stdout: '', stderr: 'The ssh program is not installed on this machine.', timedOut: false, unreachable: true };
  const r = await runCommand({ cmd: ssh, args: sshArgs(t, command), input, timeoutMs, env: sshEnv(env) });
  return { ...r, unreachable: r.code === 255 || r.timedOut };
}

// Streams a source (a remote command, or a local file) into `to`'s stdin. Both sides must exit 0.
function stream(source, to, { timeoutMs = 600000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const problem = (source.target && targetProblem(source.target)) || targetProblem(to.target);
    const ssh = findBin('ssh', { env });
    if (problem || !ssh) return resolve({ ok: false, why: problem ?? 'The ssh program is not installed on this machine.' });
    const kids = [];
    let settled = false, fromDone = false, toDone = false, timer = null, srcStream = null;
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        for (const k of kids) { try { process.kill(-k.pid, 'SIGKILL'); } catch { try { k.kill('SIGKILL'); } catch {} } }
        if (source.localPath) srcStream?.destroy(); // a stalled copy would otherwise keep the local file open
      }
      resolve({ ok, why: ok ? null : why });
    };
    const spawnSsh = (t, command, stdio) => {
      const k = spawnTracked(ssh, sshArgs(t, command), { env: sshEnv(env), stdio });
      kids.push(k);
      k.stderr?.resume();
      return k;
    };
    const dest = spawnSsh(to.target, to.command, ['pipe', 'ignore', 'pipe']);
    dest.stdin.on('error', () => {});
    if (source.localPath) {
      srcStream = createReadStream(source.localPath);
      srcStream.on('error', () => finish(false, `the copy from this machine stopped (could not read ${source.localPath})`));
      srcStream.on('end', () => { fromDone = true; if (toDone) finish(true); });
    } else {
      const src = spawnSsh(source.target, source.command, ['ignore', 'pipe', 'pipe']); // the sending side's stdin is closed
      srcStream = src.stdout;
      src.on('error', (e) => finish(false, `the copy from ${source.target.label} stopped (${e.message})`));
      src.on('close', (code) => {
        if (code !== 0) return finish(false, `the copy from ${source.target.label} stopped (code ${code ?? -1})`);
        fromDone = true;
        if (toDone) finish(true);
      });
    }
    srcStream.pipe(dest.stdin);
    dest.on('error', (e) => finish(false, `the copy to ${to.target.label} stopped (${e.message})`));
    dest.on('close', (code) => {
      if (code !== 0) return finish(false, `the copy to ${to.target.label} stopped (code ${code ?? -1})`);
      toDone = true;
      if (fromDone) finish(true);
    });
    timer = setTimeout(() => finish(false, `the copy took longer than ${Math.round(timeoutMs / 60000)} minutes`), timeoutMs);
  });
}

export const remotePipe = (from, to, opts) => stream({ target: from.target, command: from.command }, to, opts);
export const sendFile = (localPath, to, opts) => stream({ localPath }, to, opts);

const firstLine = (s, max) => {
  const line = String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return String(redact(line)).slice(0, max).replace(/[.\s]+$/, '');
};

export function sshProblem(t, r) {
  if (r.timedOut) return `${t.label} did not answer over SSH in time.`;
  if (r.code === 255) {
    return `Could not reach ${t.label} over SSH: ${firstLine(r.stderr, 160)}. Check the box is on, the SSH key is authorised and its host key is in ~/.ssh/known_hosts (see README, "Shipping client apps").`;
  }
  return `A command on ${t.label} failed (code ${r.code}): ${firstLine(r.stderr, 160)}.`;
}
