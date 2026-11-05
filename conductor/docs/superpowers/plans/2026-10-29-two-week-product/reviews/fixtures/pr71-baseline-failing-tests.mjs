// PR71 review (Claude, 5 Nov 2026): what happens to one ordinary step when the repository's tests ALREADY fail before
// Conductor changes anything (a real, executed test command that fails regardless of the edit)?
//
//   node pr71-baseline-failing-tests.mjs --conductor <conductor dir>
//
// Run it against main (after F8) and against an export of 2fac5a3^1 (before F8). Synthetic participants only; the
// workspace, Git and the test command are real.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { conductor: { type: 'string' } } });
const dir = path.resolve(values.conductor ?? '.');
const load = (p) => import(pathToFileURL(path.join(dir, p)).href);
const { runChunk } = await load('src/chunkPhase.js');
const { fakeParticipant, approve, makeCtx } = await load('test/helpers/fakes.js');

const chunk = { title: 'Rename a variable', instructions: 'edit notes.txt' };
const edit = (_role, _task, _ctx, opts) => { writeFileSync(path.join(opts.cwd, 'notes.txt'), 'renamed\n'); return { text: 'done' }; };
const team = {
  local: fakeParticipant({ name: 'local', kind: 'local-agent', script: edit }),
  author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, ...a) => (role === 'reviewer' ? approve() : edit(role, ...a)) }),
  reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: approve }), // a reviewer who accepts the unrelated, pre-existing failure
};
// The repository's own test is already broken, independent of anything this step does.
const ctx = await makeCtx({ team, files: { 'notes.txt': 'original\n', 'broken.cjs': "console.error('PRE-EXISTING FAILURE in an unrelated test'); process.exit(1);\n" },
  options: { testCommand: 'node broken.cjs', localRounds: 2, frontierRounds: 2 } });
ctx.state.plan = { summary: 'synthetic', chunks: [chunk] };
const result = await runChunk(ctx, chunk, 0);
console.log(JSON.stringify({
  status: result.status,
  localProducerCalls: team.local.calls.length,
  frontierProducerCalls: team.author.calls.filter((c) => c.role !== 'reviewer').length,
  rivalReviewCalls: team.reviewer.calls.length + team.author.calls.filter((c) => c.role === 'reviewer').length,
  operatorQuestions: ctx.hookCalls.map((h) => h.name),
}));
