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
