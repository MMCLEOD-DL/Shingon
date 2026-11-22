// Independent, short-lived launcher. Never registered with engine child cleanup.
import { spawn } from 'node:child_process';
import { strictChildEnv, redact } from '../secrets.js';

if (process.argv.includes('--local-worker-launcher')) {
  process.once('message', message => {
    if (message?.type !== 'launch') return;
    let output = '', done = false;
    const secrets = message.redactions.filter(v => typeof v === 'string' && v.length >= 8);
    const capacity = Math.max(16384, ...secrets.map(v => v.length * 2));
    const capture = value => { output = redact(output + value, secrets).slice(-capacity); };
    let child, timer;
    const finish = (code, timedOut = false) => {
      if (done) return;
      done = true; clearTimeout(timer);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      const result = { type: 'finished', code: code ?? -1, timedOut, output };
      if (process.connected) process.send(result, () => { if (process.connected) process.disconnect(); });
    };
    try {
      child = spawn(message.command[0], message.command.slice(1), {
        shell: false, detached: true, windowsHide: true, env: strictChildEnv(), stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      child.once('error', () => { capture('The configured start command could not be launched.'); finish(-1); });
      // Drain ordinary output on close. An inherited keeper pipe gets only a
      // short drain grace: it cannot hold readiness or the launcher open forever.
      child.once('close', code => finish(code));
      child.once('exit', code => { if (!done) { clearTimeout(timer); timer = setTimeout(() => finish(code), 100); } });
      timer = setTimeout(() => {
        capture('\nThe start command did not finish within its command deadline.');
        // PID only. Never kill a process group/tree: its worker must survive.
        try { child.kill(); } catch { /* may have just exited */ }
        finish(-1, true);
      }, message.timeoutMs);
    } catch { capture('The configured start command could not be launched.'); finish(-1); }
  });
  // Losing the service IPC does not terminate the command or any worker it starts.
  process.on('disconnect', () => {});
  // No command is queued until the service observes this readiness handshake.
  if (process.connected) process.send({ type: 'ready' }, () => {});
}
