// Standalone review control: deliberately outside test/ and CI discovery.
// The original missing-context refusal must remain; trusted conflict context must yield a locked warning.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeFoundationRepo } from '../../../../../test/helpers/factoryFixtures.js';
import { FOUNDATION } from '../../../../../src/council/foundationRules.js';
import { git } from '../../../../../src/workspace.js';
import { upgradeUnit } from '../../../../../src/factory/change/upgradeMerge.js';

const file = 'packages/shared/src/report.ts';
const dir = await makeFoundationRepo({ extra: { [file]:
  '<<<<<<< HEAD\nexport const app = 1;\n=======\nexport const fix = 2;\n>>>>>>> v0.2.0\n' } });
const baseSha = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
const unit = upgradeUnit({ fromTag: 'v0.1.0', toTag: 'v0.2.0', conflicts: [file], changes: [] });
// Negative control: the pre-PR25 bridge omitted trusted conflict context. Unit ids alone grant no authority.
const input = { dir, baseSha, files: [], changed: new Set(), options: {
  factoryFeature: { id: unit.id, tags: [...unit.acceptance], retire: [...unit.retire] },
} };
const [before] = await FOUNDATION.collect(input);
assert.equal(before.status, 'ran');
assert.equal(before.findings.filter((f) => f.file === file).length, 0);
console.log('CONTROL: an unchanged post-merge baseline is not a protected-file edit.');
writeFileSync(path.join(dir, file), 'export const app = 1;\nexport const fix = 2;\n');
for (const args of [ ['add', '--', file],
  ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'Resolve both sides of the upgrade conflict'] ]) {
  const result = await git(dir, args);
  assert.equal(result.code, 0, result.stderr);
}
const [after] = await FOUNDATION.collect({ ...input, files: [file], changed: new Set([file]) });
assert.equal(after.status, 'ran');
const blocked = after.findings.find((f) => f.file === file && f.grade === 'blocking' && f.locked);
assert.ok(blocked, 'a unit id alone must not authorise protected-file edits');
console.log('CONTROL: resolving a protected file without trusted conflict context remains blocked.');
// This is the field now carried by the real pipeline/build bridges, tested separately.
const [authorised] = await FOUNDATION.collect({
  ...input, files: [file], changed: new Set([file]),
  options: { factoryFeature: { ...input.options.factoryFeature, upgradeConflicts: [file] } },
});
assert.equal(authorised.status, 'ran');
const mine = authorised.findings.filter((f) => f.file === file);
assert.equal(mine.length, 1);
assert.equal(mine[0].grade, 'warning');
assert.equal(mine[0].locked, true);
assert.match(mine[0].detail, /recorded by Conductor from Git \(not by the model\)/);
console.log('PASS: the recorded conflict resolution produces a locked review warning, not a block.');
