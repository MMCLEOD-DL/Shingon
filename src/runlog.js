// src/runlog.js
import { mkdirSync, appendFileSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { makeResult } from './result.js';
import { clip } from './text.js';

export class RunLog {
  constructor(workspaceDir, { onEvent } = {}) {
    this.dir = path.join(workspaceDir, '.git', 'conductor');
    mkdirSync(this.dir, { recursive: true });
    this.transcript = path.join(this.dir, 'transcript.jsonl');
    this.statePath = path.join(this.dir, 'state.json');
    this.onEvent = onEvent;
  }

  event(type, data = {}) {
    const entry = { ts: new Date().toISOString(), type, ...data };
    appendFileSync(this.transcript, JSON.stringify(entry) + '\n');
    try { this.onEvent?.(entry); } catch {}
    return entry;
  }

  saveState(state) {
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.statePath);
  }

  loadState() {
    if (!existsSync(this.statePath)) return null;
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch (e) {
      throw new Error(`corrupt run state at ${this.statePath}: ${e.message}`);
    }
  }
}

export async function callRole(log, participant, role, task, context = '', opts = {}) {
  log.event('call', { participant: participant.name, role, task: clip(task, 1000) });
  let result;
  try {
    result = await participant.run(role, task, context, opts);
  } catch (e) {
    result = makeResult({ ok: false, error: String(e?.message ?? e) });
  }
  log.event('result', {
    participant: participant.name, role, ok: result.ok, error: result.error,
    verdict: result.verdict, costUsd: result.usage?.costUsd ?? null, text: clip(result.text, 2000),
  });
  return result;
}
