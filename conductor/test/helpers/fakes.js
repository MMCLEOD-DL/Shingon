// test/helpers/fakes.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Participant } from '../../src/participant.js';
import { makeResult } from '../../src/result.js';
import { Workspace } from '../../src/workspace.js';
import { RunLog } from '../../src/runlog.js';
import { DEFAULT_OPTIONS } from '../../src/options.js';
import { makeRepo } from './gitRepo.js';

export const approve = () => ({ verdict: { decision: 'APPROVE', reason: '' } });
export const block = (reason) => ({ verdict: { decision: 'BLOCK', reason } });

export function fakeParticipant({ name, kind = name, roles = ['author', 'reviewer', 'grunt'], script }) {
  const calls = [];
  const adapter = {
    kind,
    async run(role, task, context, opts) {
      calls.push({ role, task, context, opts });
      return makeResult(await script(role, task, context, opts, calls.length - 1));
    },
  };
  const p = new Participant({ name, adapter, roles, capabilities: { is_agentic: true, can_edit_files: true } });
  p.calls = calls;
  return p;
}

export async function makeCtx({ files, request = 'do the thing', team, hooks = {}, options = {} } = {}) {
  const repoDir = await makeRepo(files);
  const ws = await Workspace.create({ repoDir, baseDir: mkdtempSync(path.join(tmpdir(), 'ctx-')), taskId: request });
  const hookCalls = [];
  const rec = (name, ret) => async (arg) => { hookCalls.push({ name, arg }); return ret; };
  const allHooks = {
    escalate: rec('escalate', 'reject'),
    approveResult: rec('approveResult', true),
    approveChunk: rec('approveChunk', true),
    ...hooks,
  };
  const log = new RunLog(ws.metaDir, { onEvent: allHooks.onEvent });
  const state = {
    version: 1, taskId: ws.branch, request, repoDir,
    phase: 'plan', plan: null, chunkIndex: 0, chunkShas: [], notes: [], status: 'running',
  };
  return { request, team, hooks: allHooks, options: { ...DEFAULT_OPTIONS, ...options }, ws, log, state, repoDir, hookCalls };
}
