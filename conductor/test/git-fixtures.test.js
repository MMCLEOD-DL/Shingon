import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/workspace.js';
import { makeRepo } from './helpers/gitRepo.js';
import { makeFoundationRepo } from './helpers/factoryFixtures.js';

const files = {
  'lf.txt': 'first\nsecond\n',
  'crlf.txt': 'first\r\nsecond\r\n',
  'binary.dat': Buffer.from([0, 1, 10, 13, 10, 127]),
};

for (const [name, create] of [
  ['workspace', () => makeRepo(files)],
  ['foundation', () => makeFoundationRepo({ extra: files })],
]) {
  test(`${name} fixture keeps exact bytes through clone and reset under Git conversion settings`, async () => {
    const source = await create();
    for (const conversion of ['true', 'false']) {
      const parent = mkdtempSync(path.join(tmpdir(), 'fixture-eol-'));
      const clone = path.join(parent, 'clone');
      const config = ['-c', `core.autocrlf=${conversion}`, '-c', 'core.eol=crlf'];
      const copied = await git(parent, [...config, 'clone', '-q', '--no-hardlinks', source, clone]);
      assert.equal(copied.code, 0, copied.stderr);
      const assertBytes = () => {
        for (const [file, body] of Object.entries(files)) {
          assert.deepEqual(readFileSync(path.join(clone, file)), Buffer.from(body), `${file}, autocrlf=${conversion}`);
        }
      };
      assertBytes();
      for (const file of Object.keys(files)) writeFileSync(path.join(clone, file), 'changed\n');
      const reset = await git(clone, [...config, 'reset', '--hard', 'HEAD']);
      assert.equal(reset.code, 0, reset.stderr);
      assertBytes();
    }
  });
}
