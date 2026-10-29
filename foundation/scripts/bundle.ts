import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What goes in the tarball, and where it comes from. Every file is required: a bundle without its runbook is not shipped. */
const FILES: { name: string; from: string }[] = [
  { name: 'compose.yaml', from: 'deploy/compose.yaml' },
  { name: 'Caddyfile', from: 'deploy/Caddyfile' },
  { name: '.env.example', from: 'deploy/.env.example' },
  { name: 'RUNBOOK.md', from: 'docs/RUNBOOK.md' },
];

/** Builds dist/highland-bundle-<version>.tar.gz and returns its path and the files it holds. */
export function buildBundle(root = ROOT, outDir = path.join(root, 'dist')): { file: string; included: string[] } {
  const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const stage = mkdtempSync(path.join(tmpdir(), 'hf-bundle-'));
  try {
    const included: string[] = [];
    for (const f of FILES) {
      const src = path.join(root, f.from);
      if (!existsSync(src)) throw new Error(`${f.from} is missing, so the bundle cannot be made.`);
      copyFileSync(src, path.join(stage, f.name));
      included.push(f.name);
    }
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `highland-bundle-${version}.tar.gz`);
    execFileSync('tar', ['-czf', file, '-C', stage, ...included]);
    return { file, included };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { file, included } = buildBundle();
    console.log(`Made ${file}\nIt holds: ${included.join(', ')}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'The bundle could not be made.');
    process.exitCode = 1;
  }
}
