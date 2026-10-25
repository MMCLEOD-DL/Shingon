// test/helpers/councilStubs.js
// Stub council CLIs. Tests never run the real semgrep / gitleaks / npm audit / scancode.
import { writeStubCli } from './stubCli.js';

const TOOLS = ['semgrep', 'gitleaks', 'npm-audit', 'scancode'];

// bodies: { semgrep?, gitleaks?, 'npm-audit'?, scancode? } (JS run with `args` in scope).
// Returns options.councilTools: a stub path per given body, false (off) for the rest.
export function councilStubs(dir, bodies = {}) {
  const out = {};
  for (const t of TOOLS) out[t] = bodies[t] ? writeStubCli(dir, `stub-${t}`, bodies[t]) : false;
  return out;
}

export const printJson = (value) => `console.log(${JSON.stringify(JSON.stringify(value))});`;
export const reportJson = (flag, value) =>
  `require('fs').writeFileSync(args[args.indexOf(${JSON.stringify(flag)}) + 1], ${JSON.stringify(JSON.stringify(value))});`;

const WALK = `
  const fs = require('fs'), path = require('path');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(path.relative('.', p));
  } };
  walk('.');
`;

// Semgrep: one ERROR per .js file that contains "eval(".
export const SEMGREP_EVAL = `${WALK}
  const results = files.filter((f) => f.endsWith('.js') && fs.readFileSync(f, 'utf8').includes('eval('))
    .map((f) => ({ check_id: 'javascript.lang.security.eval', path: f, start: { line: 1 },
      extra: { message: 'Untrusted input reaches eval()', severity: 'ERROR' } }));
  console.log(JSON.stringify({ results, errors: [] }));
`;

// Gitleaks: one hit per file holding an AWS-style key, written to --report-path. It includes
// Secret/Match exactly as the real tool does without --redact: Conductor must never read them.
export const GITLEAKS_AKIA = `${WALK}
  const hits = [];
  for (const f of files) {
    const m = fs.readFileSync(f, 'utf8').match(/AKIA[0-9A-Z]{16}/);
    if (m) hits.push({ RuleID: 'aws-access-token', Description: 'AWS Access Key', File: f, StartLine: 1, Secret: m[0], Match: 'key = ' + m[0] });
  }
  fs.writeFileSync(args[args.indexOf('--report-path') + 1], JSON.stringify(hits));
`;
