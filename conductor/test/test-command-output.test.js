import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { makeRepo } from './helpers/gitRepo.js';

async function withWorkspace(files, run) {
  const repo = await makeRepo(files);
  const baseDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-output-'));
  let ws;
  try {
    ws = await Workspace.create({ repoDir: repo, baseDir, taskId: 'test-output' });
    await run(ws);
  } finally {
    ws?.remove();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

test('configured test shell captures child-program stdout and stderr for both pass and failure', async () => {
  await withWorkspace({
    'streams.cjs': 'process.stdout.write("stdout-marker\\n");process.stderr.write("stderr-marker\\n");process.exitCode=Number(process.argv[2]);',
  }, async (ws) => {
    for (const code of [0, 7]) {
      const result = await ws.runTests(`node streams.cjs ${code}`);
      assert.equal(result.ran, true);
      assert.equal(result.code, code);
      assert.equal(result.passed, code === 0);
      assert.match(result.output, /stdout-marker/);
      assert.match(result.output, /stderr-marker/);
    }
  });
});

test('captured child-program output stays redacted and the test environment stays credential-free', async () => {
  const key = 'synthetic-output-token-20261105';
  const before = process.env.CONDUCTOR_OUTPUT_TEST_TOKEN;
  process.env.CONDUCTOR_OUTPUT_TEST_TOKEN = key;
  try {
    await withWorkspace({
      'redaction.cjs': `console.log('token=${key}');console.log('env-present='+Boolean(process.env.CONDUCTOR_OUTPUT_TEST_TOKEN));`,
    }, async (ws) => {
      const result = await ws.runTests('node redaction.cjs');
      assert.equal(result.passed, true);
      assert.match(result.output, /token=\[redacted\]/);
      assert.match(result.output, /env-present=false/);
      assert.ok(!result.output.includes(key));
    });
  } finally {
    if (before === undefined) delete process.env.CONDUCTOR_OUTPUT_TEST_TOKEN;
    else process.env.CONDUCTOR_OUTPUT_TEST_TOKEN = before;
  }
});

test('native Windows shell timeout retains partial output and kills the child-program tree', {
  skip: process.platform !== 'win32',
}, async () => {
  await withWorkspace({
    'hanging.cjs': 'const {spawn}=require("node:child_process");const {writeFileSync}=require("node:fs");const child=spawn(process.execPath,["-e","setTimeout(()=>{},8000)"],{windowsHide:true,stdio:"inherit"});writeFileSync("child.pid",String(child.pid));process.stdout.write("started-marker\\n");setTimeout(()=>{},8000);',
  }, async (ws) => {
    const result = await ws.runTests('node hanging.cjs', { timeoutMs: 2500 });
    const pid = Number(readFileSync(path.join(ws.dir, 'child.pid'), 'utf8'));
    assert.equal(result.passed, false);
    assert.match(result.output, /started-marker/);
    assert.match(result.output, /test command timed out/);
    assert.throws(() => process.kill(pid, 0), /ESRCH|no such process|not found/i);
  });
});
