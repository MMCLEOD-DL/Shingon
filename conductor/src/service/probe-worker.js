import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appConfig } from './config.js';
import { runCommand, killAllChildren } from '../exec.js';
import { classifyFailure } from '../health.js';
import { redact } from '../secrets.js';

export async function performProbe({ participant, kind, command = runCommand }) {
  const result = { participantId: participant.name, adapter: participant.adapter.kind,
    executable: 'unknown', authentication: participant.adapter.kind === 'local-agent' ? 'not-applicable' : 'unknown',
    endpoint: participant.adapter.kind === 'local-agent' ? 'unknown' : 'not-applicable', agenticExecution: 'unknown',
    checkedAt: new Date().toISOString(), probeKind: kind, reason: null, action: null };
  const installed = await command({ cmd: participant.adapter.bin, args: ['--version'], timeoutMs: 15000 });
  result.executable = installed.code === 0 && !installed.timedOut ? 'found' : 'missing';
  if (result.executable === 'missing') return { ...result, reason: 'not-installed', action: 'Install the supported CLI on this host, then retry.' };
  if (kind === 'installation') return result;
  let dir;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'conductor-probe-'));
    // Probe directories are disposable and contain no project or company data.
    const init = await command({ cmd: 'git', args: ['init', '-q', dir], timeoutMs: 15000 });
    if (init.code !== 0) return { ...result, reason: 'git-unavailable', action: 'Install Git before checking model execution.' };
    const nonce = randomUUID();
    const filename = `probe-${nonce}.txt`;
    const prompt = kind === 'agentic'
      ? `In this disposable directory, create ${filename} containing exactly ${nonce}. Do not read other files or use the network. Reply OK.`
      : `Reply with exactly this synthetic connection-check text: ${nonce}. Do not use tools or read files.`;
    // Keep a synthetic marker in the directory for human diagnosis, not a secret.
    writeFileSync(path.join(dir, 'README.txt'), 'Disposable Conductor model connection check.\n');
    const answer = await participant.adapter.run('reviewer', prompt, '', { cwd: dir, write: kind === 'agentic', timeoutMs: 60000 });
    const good = answer.ok && (kind === 'agentic'
      ? (() => { try { return readFileSync(path.join(dir, filename), 'utf8').trim() === nonce; } catch { return false; } })()
      : answer.text?.includes(nonce));
    if (good) {
      if (participant.adapter.kind === 'local-agent') result.endpoint = 'reachable';
      else result.authentication = 'verified';
      if (kind === 'agentic') result.agenticExecution = 'verified';
    } else {
      result.reason = answer.failure === 'timeout' ? 'timeout' : classifyFailure(answer.error ?? '');
      if (result.reason === 'unauthorized') result.authentication = 'required';
      result.action = 'Check the installed CLI account, selected model and endpoint; retry explicitly. This check may use subscription allowance.';
    }
    return result;
  } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}
if (process.send) {
  process.once('message', async input => {
    try {
      const config = appConfig(input.configFile);
      const participant = config.participants.find(p => p.name === input.participantId);
      if (!participant || !['installation', 'authenticated', 'agentic'].includes(input.kind)) throw new Error('Invalid probe');
      const result = await performProbe({ participant, kind: input.kind });
      process.send(redact({ ok: true, result }));
    } catch { process.send({ ok: false }); }
    finally { killAllChildren(); }
  });
  process.on('disconnect', () => { killAllChildren(); process.exit(0); });
}
