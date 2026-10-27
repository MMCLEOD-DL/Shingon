// src/council/progress.js — one short plain-words progress line per council event, or null (Task 13).
import { MEMBER_LABEL } from './findings.js';

const STAGE_WORDS = {
  acquire: 'starting the test machine',
  push: 'copying the app to the test machine',
  smoke: 'the reliability test',
  gates: 'the extra checks',
  cleanup: 'tidying the test machine',
  release: 'handing back the test machine',
  reuse: "reading the build's own checks",
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const label = (m) => MEMBER_LABEL[m] ?? String(m);

export function councilProgressLine(e) {
  switch (e?.type) {
    case 'council-start':
      return `Council round ${e.round}: ${(e.members ?? []).map(label).join(', ')}`;
    case 'council-evidence':
      if (e.status === 'error') return `Council: ${STAGE_WORDS[e.stage] ?? 'a check'} did not finish.`;
      if (e.stage === 'reuse' && e.status === 'ok') return "Council: using the build's own checks for this version.";
      if (e.stage === 'gates' && e.status === 'start') return 'Council: running the checks the build did not cover (axe, or missing reports)…';
      if (e.stage === 'acquire' && e.status === 'start') return 'Council: starting a test machine…';
      if (e.stage === 'smoke' && e.status === 'start') return `Council: deploying on test machine ${e.machine}: backup, restore, alerts and updates (10–20 minutes)…`;
      if (e.stage === 'cached') return 'Council: using the checks already done for this version.';
      return null;
    case 'council-member':
      return e.stage === 'interpreting' ? `Council: ${label(e.member)} is being read by the reviewer…` : null;
    case 'council-verdict':
      if (e.verdict === 'blocked') return `Council round ${e.round}: ${plural(e.blocking ?? 0, 'problem')} to fix`;
      return `Council round ${e.round}: approved${e.warning > 0 ? `, ${plural(e.warning, 'warning')}` : ''}`;
    case 'council-report-saved':
      return `Council report saved: ${e.md}`;
    default:
      return null;
  }
}
