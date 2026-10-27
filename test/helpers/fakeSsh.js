// test/helpers/fakeSsh.js
// A scripted stand-in for `ssh`: an executable Node stub first on PATH. No test opens a real connection.
// Rule: { host?, match (regex on the shQuoted command), once?, stdout?, subst?, stdoutFile?, stderr?, code?, saveStdinTo? }.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeStubCli } from './stubCli.js';

export function fakeSsh(dir, rules = []) {
  const base = path.resolve(dir, 'fakessh');
  const binDir = path.join(base, 'bin');
  mkdirSync(binDir, { recursive: true });
  const rulesFile = path.join(base, 'rules.json');
  const usedFile = path.join(base, 'used.json');
  const callsFile = path.join(base, 'calls.jsonl');
  writeFileSync(rulesFile, JSON.stringify(rules));
  writeFileSync(usedFile, '[]');
  writeFileSync(callsFile, '');
  writeStubCli(binDir, 'ssh', `
const fs = require('node:fs');
const i = args.indexOf('--');
const host = args[i + 1], command = args[i + 2];
const user = args[args.indexOf('-l') + 1];
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const buf = Buffer.concat(chunks);
  fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv: args, user, host, command, stdin: buf.subarray(0, 1048576).toString('utf8') }) + '\\n');
  const rules = JSON.parse(fs.readFileSync(${JSON.stringify(rulesFile)}, 'utf8'));
  const used = JSON.parse(fs.readFileSync(${JSON.stringify(usedFile)}, 'utf8'));
  let rule = null, groups = null;
  for (let n = 0; n < rules.length; n++) {
    const r = rules[n];
    if (r.once && used.includes(n)) continue;
    if (r.host && r.host !== host) continue;
    const m = new RegExp(r.match).exec(command);
    if (!m) continue;
    rule = r; groups = m;
    if (r.once) { used.push(n); fs.writeFileSync(${JSON.stringify(usedFile)}, JSON.stringify(used)); }
    break;
  }
  if (!rule) process.exit(0);
  if (rule.saveStdinTo) fs.writeFileSync(rule.saveStdinTo, buf);
  if (rule.stdoutFile) process.stdout.write(fs.readFileSync(rule.stdoutFile));
  // subst: "$1".."$9" in stdout become the rule's regex groups (a run folder named in the command, say).
  if (rule.stdout) process.stdout.write(rule.subst ? rule.stdout.replace(/\\$(\\d)/g, (_, n) => groups[n] ?? '') : rule.stdout);
  if (rule.stderr) process.stderr.write(rule.stderr);
  const code = rule.code ?? 0;
  process.stdout.write('', () => process.exit(code));
});
`);
  return {
    binDir,
    env(baseEnv = process.env) { return { ...baseEnv, PATH: `${binDir}:${baseEnv.PATH ?? ''}` }; },
    setRules(r) { writeFileSync(rulesFile, JSON.stringify(r)); writeFileSync(usedFile, '[]'); },
    calls() {
      if (!existsSync(callsFile)) return [];
      return readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}
