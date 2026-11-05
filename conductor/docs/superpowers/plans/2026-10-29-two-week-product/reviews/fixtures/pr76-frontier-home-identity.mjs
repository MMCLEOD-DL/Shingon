// PR76 review (Claude, 5 Nov 2026). node pr76-frontier-home-identity.mjs <conductor dir>
// Offline: prepareHome never runs Codex; auth.json here is a synthetic stand-in written by this script.
// Which changes move the frontier Codex home (and so lose its sign-in)? Offline: prepareHome never runs Codex.
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = path.resolve(process.argv[2] ?? '.');
const cache = mkdtempSync(path.join(tmpdir(), 'pr76-cache-'));
process.env.XDG_CACHE_HOME = cache;
const { CodexAdapter } = await import(pathToFileURL(path.join(dir, 'src/adapters/codex.js')).href);
const cwd = mkdtempSync(path.join(tmpdir(), 'pr76-cwd-'));
const home = (opts) => new CodexAdapter(opts).prepareHome({ cwd });
const before = await home({ bin: 'C:/Users/op/AppData/Roaming/npm/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe' });
writeFileSync(path.join(before, 'auth.json'), '{"synthetic":"signed-in"}'); // stand-in for Codex's own sign-in
const rows = {
  'same bin, different model': await home({ bin: 'C:/Users/op/AppData/Roaming/npm/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe', model: 'other' }),
  'same bin, extraConfig added': await home({ bin: 'C:/Users/op/AppData/Roaming/npm/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe', extraConfig: ['model_reasoning_effort="high"'] }),
  'npm update moved codex.exe (S2)': await home({ bin: 'C:/Users/op/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.exe' }),
};
for (const [k, h] of Object.entries(rows)) console.log(`${k}: ${h === before ? 'same home, still signed in' : `NEW home, signed in: ${existsSync(path.join(h, 'auth.json'))}`}`);
console.log('homes left in cache:', readdirSync(path.dirname(before)).length, '; old sign-in file still present:', existsSync(path.join(before, 'auth.json')));
