import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { main } from '../../src/cli/main.js';

export const tmp = () => mkdtempSync(path.join(tmpdir(), 'fcli-'));
export function capture() { let text = ''; const out = new Writable({ write(c, e, cb) { text += c; cb(); } }); out.text = () => text; return { out, text: () => text }; }
// stdout: a Writable with a text() method (Task 10's interactive()); main: overrides for onSignal / exit.
export async function runMain(argv, { env, cwd = tmp(), isTTY = false, stdin = new PassThrough(), stdout = null, deps, main: over = {} } = {}) {
  const o = stdout ?? capture().out;
  if (!o.text) { let t = ''; const w = o.write.bind(o); o.write = (c, ...rest) => { t += c; return w(c, ...rest); }; o.text = () => t; }
  const code = await main(argv, { cwd, env, stdin, stdout: o, isTTY, onSignal: () => {}, exit: () => {}, ...over, ...(deps ? { factoryDeps: deps } : {}) });
  return { code, out: o.text() };
}
export const envFor = (root) => ({ ...process.env, CONDUCTOR_PROJECTS_ROOT: root, XDG_CONFIG_HOME: tmp(), HOME: tmp() });

import http from 'node:http';
import { writeFileSync as wf } from 'node:fs';
import { writeStubCli } from './stubCli.js';

// Answers each prompt once it is on screen (a chunk ending "> " or "(one line): "); with none left, ends input.
// out.text() is everything shown, so runMain can return it.
export function interactive(answers, { onPrompt = () => {} } = {}) {
  const stdin = new PassThrough();
  const queue = [...answers];
  let text = '';
  const out = new Writable({ write(c, e, cb) { const s = c.toString(); text += s;
    if (s.endsWith('> ') || s.endsWith('(one line): ')) { onPrompt(text); setImmediate(() => (queue.length ? stdin.write(`${queue.shift()}\n`) : stdin.end())); }
    cb(); } });
  out.text = () => text;
  return { stdin, out, text: () => text };
}

// A config whose author is a stub `claude` (first reply: a draft with a question; once answers are in: the final
// brief) and whose local model is a 127.0.0.1 server that records every request body. Codex must never be called.
export async function briefWorld({ first, second }) {
  const bodies = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { bodies.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bins = tmp();
  const promptLog = path.join(bins, 'prompts.log');
  const fence = (o) => 'Draft.\n```json\n' + JSON.stringify(o) + '\n```';
  const claude = writeStubCli(bins, 'claude', `
    const fs = require('fs');
    if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
    const prompt = args[args.indexOf('-p') + 1] || '';
    fs.appendFileSync(${JSON.stringify(promptLog)}, prompt + '\\n=====\\n');
    const result = prompt.includes('The operator has answered') ? ${JSON.stringify(fence(second))} : ${JSON.stringify(fence(first))};
    process.stdout.write(JSON.stringify({ result, is_error: false, total_cost_usd: 0.02 }));`);
  const codex = writeStubCli(bins, 'codex', `if (args[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); } console.error('ERROR: codex should not be called'); process.exit(1);`);
  const cfg = path.join(tmp(), 'conductor.json');
  wf(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'codex', adapter: 'codex', bin: codex, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'local', adapter: 'local-agent', bin: codex, model: 'm', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, roles: ['grunt'], capabilities: { is_agentic: true, can_edit_files: true } },
  ], routing: { author: 'claude' }, factory: { operatorName: 'Malcolm' } }));
  return { cfg, bodies, promptLog, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}
