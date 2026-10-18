// test/helpers/stubCli.js
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Writes an executable Node script that acts as a fake CLI. bodyJs runs with
// `args` (process.argv.slice(2)) in scope. Returns the stub's absolute path.
export function writeStubCli(dir, name, bodyJs) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\n${bodyJs}\n`);
  chmodSync(file, 0o755);
  return file;
}
