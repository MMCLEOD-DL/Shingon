// src/council/findings.js
// The council's Finding shape and grading rules. Every finding has a ceiling (maxGrade)
// that nothing downstream (the interpreter) can raise it above (plan 5, Ruling 6).
import { redact } from '../secrets.js';
import { clip } from '../text.js';

export const GRADES = Object.freeze(['blocking', 'warning', 'note']);
export const MEMBER_LABEL = Object.freeze({ security: 'Security', legal: 'Legal', correctness: 'Correctness', foundation: 'Foundation rules', design: 'Design', reliability: 'Reliability' });

const checkGrade = (g) => {
  if (!GRADES.includes(g)) throw new Error(`unknown grade: ${g}`);
  return g;
};

// Never more severe than max.
export function clampGrade(grade, max) {
  return GRADES.indexOf(grade) >= GRADES.indexOf(max) ? grade : max;
}

export function makeFinding(spec) {
  const { member, tool = null, title, detail, file = null, line = null, preExisting = false, why = null, fix = null } = spec;
  if (!Object.hasOwn(MEMBER_LABEL, member)) throw new Error(`unknown council member: ${member}`);
  const grade = checkGrade(spec.grade);
  const wanted = spec.maxGrade === undefined || spec.maxGrade === null
    ? (grade === 'blocking' ? 'blocking' : 'warning')
    : checkGrade(spec.maxGrade);
  const evidence = Boolean(tool);
  const maxGrade = clampGrade(wanted, (!evidence || preExisting) ? 'warning' : 'blocking');
  return {
    member,
    tool: tool ?? null,
    grade: clampGrade(grade, maxGrade),
    maxGrade,
    title: clip(redact(String(title)).split('\n')[0], 200),
    detail: clip(redact(String(detail ?? '')), 2000),
    file: file ?? null,
    line: Number.isInteger(line) ? line : null,
    evidence,
    locked: Boolean(spec.locked),
    preExisting: Boolean(preExisting),
    dismissed: Boolean(spec.dismissed),
    why,
    fix,
  };
}

export const findingKey = (f) => `${f.member}|${f.tool ?? 'ai'}|${f.file ?? ''}|${f.title}`;

export function tally(findings) {
  const out = { blocking: 0, warning: 0, note: 0 };
  for (const f of findings) if (!f.dismissed) out[f.grade] += 1;
  return out;
}
