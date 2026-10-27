// src/council/reportFile.js
// The council report saved in the build folder (Contract 7.5): Plans 11 and 12 read the council result from
// <projectDir>/builds/<runId>/council-report.{md,json}. Both are written atomically with Plan 7's writeFileAtomic.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../factory/fsAtomic.js';
import { redact } from '../secrets.js';

export async function writeCouncilReport(buildDir, report) {
  mkdirSync(buildDir, { recursive: true });
  const md = path.join(buildDir, 'council-report.md');
  const json = path.join(buildDir, 'council-report.json');
  const { text, ...rest } = report;
  writeFileAtomic(md, redact(String(text ?? '')));
  writeFileAtomic(json, `${JSON.stringify(redact(rest), null, 2)}\n`);
  return { md, json };
}
