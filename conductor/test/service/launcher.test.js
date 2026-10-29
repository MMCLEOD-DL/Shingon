import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = fileURLToPath(new URL('../../bin/conductor-app.js', import.meta.url));
test('the real launcher starts, stops and starts again without model calls or WSL', { timeout: 15000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'operator-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let previousToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(process.execPath, [cli, '--port', '0', '--config', path.join(root, 'missing-config.json'), '--data', path.join(root, 'data')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let closed = false;
    const exited = new Promise(resolve => child.once('exit', code => { closed = true; resolve(code); }));
    t.after(() => { if (!closed) child.kill(); });
    const link = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Launcher did not become ready')), 5000);
      child.stdout.on('data', c => {
        output += c;
        const m = /http:\/\/127\.0\.0\.1:\d+\/#bootstrap=([a-f0-9]{64})/.exec(output);
        if (m) { clearTimeout(timer); resolve(new URL(m[0])); }
      });
      child.once('error', e => { clearTimeout(timer); reject(e); });
    });
    const token = new URLSearchParams(link.hash.slice(1)).get('bootstrap');
    assert.notEqual(token, previousToken); previousToken = token;
    const login = await fetch(link.origin + '/api/v1/session', { method: 'POST', headers: { origin: link.origin, 'content-type': 'application/json' }, body: JSON.stringify({ bootstrapToken: token }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const setup = await fetch(link.origin + '/api/v1/setup', { headers: { cookie } });
    assert.equal((await setup.json()).configured, false);
    const rootPage = await fetch(link.origin);
    const pageText = await rootPage.text();
    const builtUi = path.resolve(path.dirname(cli), '../operator-web/dist/index.html');
    if (existsSync(builtUi)) assert.equal(pageText, readFileSync(builtUi, 'utf8'));
    else assert.match(pageText, /UI has not been built/);
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  }
});
