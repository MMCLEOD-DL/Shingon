// A thin wrapper around the ssh and scp clients. Never throws except on an unsafe host, user or path.
import { runCommand } from '../exec.js';
import { childEnv, redact } from '../secrets.js';
import { assertSafe } from './remote.js';

export const unreachable = (r) => r.code === 255;

export function createSsh({ sshBin = 'ssh', scpBin = 'scp', run = runCommand } = {}) {
  const prep = (machine) => {
    const host = assertSafe('host', machine.host);
    const user = assertSafe('user', machine.ssh.user);
    const policy = machine.ssh.hostKeyPolicy;
    if (policy !== 'yes' && policy !== 'accept-new') throw new Error(`unsafe hostKeyPolicy for ssh: ${JSON.stringify(policy)}`);
    const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'IdentitiesOnly=yes',
      '-i', machine.ssh.keyPath, '-o', `StrictHostKeyChecking=${policy}`];
    if (machine.ssh.knownHostsFile) opts.push('-o', `UserKnownHostsFile=${machine.ssh.knownHostsFile}`);
    return { opts, target: `${user}@${host}` };
  };
  const done = async (p) => {
    const r = await p;
    return { code: r.code, stdout: r.stdout, stderr: redact(r.stderr) };
  };
  return {
    async exec(machine, script, { timeoutMs = 600000 } = {}) {
      const { opts, target } = prep(machine);
      return done(run({ cmd: sshBin, args: [...opts, target, 'bash -s'], input: script, timeoutMs, env: childEnv() }));
    },
    async upload(machine, localFile, remotePath, { timeoutMs = 600000 } = {}) {
      const { opts, target } = prep(machine);
      assertSafe('path', remotePath);
      return done(run({ cmd: scpBin, args: ['-B', '-q', ...opts, localFile, `${target}:${remotePath}`], timeoutMs, env: childEnv() }));
    },
  };
}
