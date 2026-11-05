// test/helpers/stubCli.js
import { writeFileSync, chmodSync, mkdirSync, mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { strictChildEnv } from '../../src/secrets.js';

let nativeLauncher;
function windowsLauncher() {
  if (nativeLauncher) return nativeLauncher;
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET');
  const compiler = ['Framework64', 'Framework'].map(dir => path.join(framework, dir, 'v4.0.30319', 'csc.exe')).find(existsSync);
  if (!compiler) throw new Error('Native Windows CLI fixtures require the installed .NET Framework 4 C# compiler');
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-cli-launcher-'));
  const output = path.join(root, 'stub.exe');
  try {
    const source = fileURLToPath(new URL('./nativeStubLauncher.cs', import.meta.url));
    const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', `/out:${output}`, source], {
      windowsHide: true, timeout: 30000, encoding: 'utf8', env: strictChildEnv(),
    });
    if (result.status !== 0) throw new Error(`Native CLI fixture compilation failed: ${result.error?.message || result.stdout || result.stderr}`);
    nativeLauncher = output;
    process.once('exit', () => rmSync(root, { recursive: true, force: true }));
    return output;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// Writes an executable Node script that acts as a fake CLI. bodyJs runs with
// `args` (process.argv.slice(2)) in scope. Returns the stub's absolute path.
export function writeStubCli(dir, name, bodyJs) {
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.exe`);
    copyFileSync(windowsLauncher(), file);
    writeFileSync(`${file}.node`, process.execPath);
    writeFileSync(`${file}.cjs`, `const args = process.argv.slice(2);\n${bodyJs}\n`);
    return file;
  }
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\n${bodyJs}\n`);
  chmodSync(file, 0o755);
  return file;
}
