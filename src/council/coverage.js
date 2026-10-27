// src/council/coverage.js
// Every worked example in the approved brief needs a PASSING test whose title carries its tag
// (index Ruling 8). Ids and tags come from Plan 7 (acceptanceIds, testTag); nothing is rebuilt here.
import { acceptanceIds, testTag } from '../factory/acceptance.js';
import { makeFinding } from './findings.js';

export const TAG_PATTERN = /\[([a-z0-9][a-z0-9-]*#\d+)\]/g;

const finding = (spec) => makeFinding({ member: 'correctness', tool: 'coverage', ...spec });

// cases: [{ title, status: 'passed' | 'failed' | 'skipped' | 'todo', message }]
// missing: 'test' | 'browser' | null, the report that did not exist (a lone gap makes "no match" unprovable, not blocking).
export function coverageFindings(brief, cases, { missing = null } = {}) {
  const examples = acceptanceIds(brief);
  const list = cases ?? [];
  const findings = [];
  const lines = [];
  let proven = 0;
  for (const ex of examples) {
    const tag = testTag(ex.id);
    const hits = list.filter((c) => String(c.title ?? '').includes(tag));
    const bad = hits.find((c) => c.status === 'failed');
    if (bad) {
      findings.push(finding({
        grade: 'blocking', locked: true, title: `Worked example ${ex.id} fails its test`,
        detail: `${bad.title}${bad.message ? `: ${bad.message}` : ''}`,
      }));
      lines.push(`${ex.id}: its test fails`);
    } else if (hits.some((c) => c.status === 'passed')) {
      proven += 1;
    } else if (missing) {
      findings.push(finding({
        grade: 'warning', locked: true, title: `Worked example ${ex.id} is not proven: the ${missing} report was missing`,
        detail: `Feature: ${ex.title}. The ${missing} report was missing, so a test for ${tag} could not be looked for.`,
      }));
      lines.push(`${ex.id}: not proven, the ${missing} report was missing`);
    } else {
      const { given, when, then } = ex.example;
      findings.push(finding({
        grade: 'blocking', locked: true, title: `Worked example ${ex.id} has no test`,
        detail: `Feature: ${ex.title}. Given ${given}, when ${when}, then ${then}. Write a test whose title includes ${tag}.`,
      }));
      lines.push(`${ex.id}: no test`);
    }
  }
  for (const f of brief.features ?? []) {
    if (!(f.acceptance ?? []).length) {
      findings.push(finding({ grade: 'warning', locked: true, title: `Feature ${f.id} has no worked examples`, detail: `Feature: ${f.title}. Add worked examples to the brief so each can be tested.` }));
    }
  }
  const known = new Set(examples.map((e) => e.id));
  const unknown = new Set();
  for (const c of list) for (const m of String(c.title ?? '').matchAll(TAG_PATTERN)) if (!known.has(m[1])) unknown.add(m[1]);
  for (const id of unknown) {
    findings.push(finding({ grade: 'note', title: `A test names worked example ${id}, which the brief does not have`, detail: 'Remove the tag, or add the example to the brief.' }));
  }
  return { findings, proven, total: examples.length, lines: [`Worked examples proven: ${proven} of ${examples.length}.`, ...lines] };
}
