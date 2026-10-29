import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ServiceError } from './state.js';

// All CLI/provider subprocesses belong to a disposable probe worker, never the
// HTTP process's process-wide registry. A probe cannot overlap a coding run.
export function probeParticipant(input) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
    const child = fork(fileURLToPath(new URL('./probe-worker.js', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env, execArgv: [], windowsHide: true });
    let result = null;
    const timer = setTimeout(() => { if (child.connected) child.disconnect(); else child.kill(); }, 95000);
    child.on('message', msg => { result = msg; if (child.connected) child.disconnect(); });
    child.on('error', () => { clearTimeout(timer); reject(new ServiceError(503, 'probe-failed', 'The connection check could not start.')); });
    child.on('exit', () => { clearTimeout(timer); if (result?.ok) resolve(result.result); else reject(new ServiceError(503, 'probe-failed', 'The connection check failed or timed out. Check the selected participant and local CLI sign-in.')); });
    child.send(input);
  });
}
