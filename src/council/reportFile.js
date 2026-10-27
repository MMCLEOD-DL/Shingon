// src/council/reportFile.js
// The council report saved in the build folder (Contract 7.5): Plans 11 and 12 read the council result from
// <projectDir>/builds/<runId>/council-report.{md,json}. Both are written atomically with Plan 7's writeFileAtomic.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../factory/fsAtomic.js';
import { redact } from '../secrets.js';

// meta = { sha, runId, secretSeen }: the reviewed commit, the build run and whether a secret was seen,
// so a reader can tell whose report this is.
export async function writeCouncilReport(buildDir, report, meta = {}) {
  mkdirSync(buildDir, { recursive: true });
  const md = path.join(buildDir, 'council-report.md');
  const json = path.join(buildDir, 'council-report.json');
  const { text, ...rest } = report;
  const { sha = null, runId = null, secretSeen = false } = meta;
  writeFileAtomic(md, redact(String(text ?? '')));
  writeFileAtomic(json, `${JSON.stringify(redact({ sha, runId, secretSeen: secretSeen === true, ...rest }), null, 2)}\n`);
  return { md, json };
}

// A round on a new commit paused before it finished: a saved report for any other commit is no longer current,
// so it is replaced by a short "paused" pair naming the commit under review. A report for this commit is kept.
export function markCouncilReportStale(buildDir, { sha, runId, reason }) {
  const md = path.join(buildDir, 'council-report.md');
  const json = path.join(buildDir, 'council-report.json');
  let saved;
  try { saved = readFileSync(json, 'utf8'); } catch { return false; }
  let old = null;
  try { old = JSON.parse(saved); } catch { /* unreadable: stale */ }
  if (old && old.sha === sha) return false;
  const why = redact(String(reason ?? ''));
  writeFileAtomic(json, `${JSON.stringify({ sha, runId, status: 'paused', reason: why }, null, 2)}\n`);
  writeFileAtomic(md, `The council review of commit ${sha} paused before it finished: ${why}\nThe report for an earlier commit was removed, because it is no longer current.\n`);
  return true;
}
