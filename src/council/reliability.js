// src/council/reliability.js
// Reliability member (spec §2 item 4, "it must not break"). Reads only input.evidence (Task 6's smoke result).
// A failed smoke step blocks. Anything that could not prove reliability (no machine, refused, timed out, error,
// off) is a LOCKED warning, never silent and never a block (index Ruling 7). The smoke tail is already redacted.
import { makeFinding } from './findings.js';
import { TOOL_LABEL } from './tools.js';
import { SMOKE_STEPS } from './smoke.js';

const MEMBER = 'reliability';
const TOOL = 'smoke';
const NOT_COVERED = 'Not covered: a sudden crash of the database or the box (the test stops and starts the app and ops cleanly).';

const finding = (spec) => makeFinding({ member: MEMBER, tool: TOOL, ...spec });
const stepTitle = (n) => SMOKE_STEPS[n] ?? (n ? `step ${n}` : null);

const notProven = (reason, detail) => finding({
  grade: 'warning', locked: true,
  title: `Reliability was not proven: ${reason}`,
  detail: detail ?? reason,
});

export function smokeFindings(smoke, { machine } = {}) {
  if (!smoke) return [notProven('no result came back from the reliability test')];
  if (smoke.refused) return [notProven(smoke.refused)];
  if (smoke.passed) {
    return [finding({
      grade: 'note',
      title: `Deployed on a fresh test machine (${machine ?? 'the test machine'}), backed up and restored, stopped and restarted with the alert sent and cleared, and a broken update undone automatically`,
      detail: '',
    })];
  }
  const detail = [smoke.failure, smoke.tail].filter(Boolean).join('\n');
  if (smoke.timedOut) {
    const at = stepTitle(smoke.failedStep);
    return [notProven(`the test took longer than the time allowed${at ? ` (it stopped at: ${at})` : ''}`, detail)];
  }
  return [finding({
    grade: 'blocking', locked: true,
    title: `The reliability test failed at: ${stepTitle(smoke.failedStep) ?? 'before its first step'}`,
    detail,
  })];
}

function smokeContext(smoke) {
  const lines = (smoke?.steps ?? []).map((s) => `${s.ok ? '✓' : '✗'} ${s.title}`);
  return [...lines, NOT_COVERED].join('\n');
}

export const RELIABILITY = {
  member: MEMBER,
  label: 'Reliability',
  alwaysInterpret: false,
  async collect(input) {
    if (!input?.brief) return [];
    const ev = input.evidence ?? {};
    const smoke = ev.smoke ?? null;
    const base = { tool: TOOL, label: TOOL_LABEL[TOOL], note: null, context: smokeContext(smoke) };
    if (!smoke) {
      const status = ['missing', 'off', 'error'].includes(ev.smokeStatus) ? ev.smokeStatus : 'missing';
      const note = ev.smokeNote || 'the reliability test gave no result';
      return [{ ...base, status, findings: [notProven(note)], note }];
    }
    const findings = smokeFindings(smoke, { machine: ev.machine });
    if (smoke.refused) return [{ ...base, status: 'error', findings, note: smoke.refused }];
    if (smoke.timedOut) return [{ ...base, status: 'error', findings, note: findings[0].title }];
    return [{ ...base, status: 'ran', findings }];
  },
};
