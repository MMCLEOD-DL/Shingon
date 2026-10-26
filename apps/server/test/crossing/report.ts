import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrossingFailure } from './harness.js';

// apps/server/reports, wherever the tests are started from.
const DEFAULT_DIR = fileURLToPath(new URL('../../reports', import.meta.url));

/** Writes reports/crossing.json for the council and reports/crossing.md in plain English for the operator. */
export async function writeCrossingReport(r: { routes: number; checks: number; failures: CrossingFailure[] }, dir?: string): Promise<void> {
  const out = dir === undefined ? DEFAULT_DIR : resolve(dir);
  await mkdir(out, { recursive: true });
  const json = { generatedAt: new Date().toISOString(), routes: r.routes, checks: r.checks, failures: r.failures };
  await writeFile(join(out, 'crossing.json'), JSON.stringify(json, null, 2) + '\n');
  const n = r.failures.length;
  const lines = [
    '# Role-crossing check',
    '',
    `**${String(r.routes)} routes, ${String(r.checks)} checks, ${String(n)} ${n === 1 ? 'problem' : 'problems'}.**`,
    '',
    ...(n === 0 ? ['No role could reach data it should not.'] : r.failures.map((f) => `- ${f.sentence}`)),
    '',
  ];
  await writeFile(join(out, 'crossing.md'), lines.join('\n'));
}
