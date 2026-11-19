// G4 step checks: what each coding step's configured checks found, for the operator. Built from the `gate`,
// `scope-flag` and `protected-path` progress events the service forwards (docs/operator-app/interface.md,
// "G4 step activity"). Stage names, output excerpts and file names come from the repository and the models, so they
// are untrusted: always plain React text, never markup.
import { plain } from '../text.js';

const STEP_TYPES = new Set(['gate', 'scope-flag', 'protected-path']);
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);

/** One record per step: its gate attempts, files outside its expected set, and protected files it touched. Null if none. */
export function stepChecksSummary(events) {
  const steps = new Map();
  for (const e of events ?? []) {
    const d = e?.data;
    if (e?.type !== 'progress' || !STEP_TYPES.has(d?.engineType)) continue;
    const index = Number.isSafeInteger(d.index) && d.index >= 0 ? d.index : null;
    const key = index ?? 'none';
    if (!steps.has(key)) steps.set(key, { index, attempts: [], outside: [], protectedFiles: [] });
    const step = steps.get(key);
    if (d.engineType === 'gate') {
      step.attempts.push({
        seq: e.seq,
        attempt: positive(d.attempt) ? d.attempt : null,
        of: positive(d.of) ? d.of : null,
        result: d.result === 'passed' || d.result === 'failed' ? d.result : null,
        failedStage: typeof d.failedStage === 'string' && d.failedStage ? d.failedStage : null,
        excerpt: typeof d.excerpt === 'string' && d.excerpt ? d.excerpt : null,
      });
    } else {
      const files = strings(d.engineType === 'scope-flag' ? d.outside : d.files);
      const total = d.engineType === 'scope-flag' ? d.outsideCount : d.fileCount;
      const entry = { seq: e.seq, files, total: Number.isSafeInteger(total) && total >= files.length ? total : files.length, truncated: d.truncated === true };
      if (d.engineType === 'scope-flag') step.outside.push(entry);
      else step.protectedFiles.push({ ...entry, participant: typeof d.participant === 'string' && d.participant ? d.participant : null });
    }
  }
  if (!steps.size) return null;
  return [...steps.values()].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
}

const stepName = (index) => (index === null || index === undefined ? 'A step' : `Step ${index + 1}`);
const attemptName = (a) => (a.attempt ? `Attempt ${a.attempt}${a.of ? ` of ${a.of}` : ''}` : 'An attempt');
const stage = (name) => `the “${plain(name, 256)}” check`;

function FileList({ entry }) {
  return (
    <>
      <ul className="files">{entry.files.map((f, i) => <li key={`${i}-${f}`}><code>{plain(f, 512)}</code></li>)}</ul>
      {entry.truncated || entry.total > entry.files.length
        ? <p className="muted">Showing {entry.files.length} of {count(entry.total, 'file')}; the rest were left out of the record.</p>
        : null}
    </>
  );
}

function Attempt({ a }) {
  if (a.result === 'passed') return <li>{attemptName(a)}: the checks passed.</li>;
  if (a.result !== 'failed') return <li>{attemptName(a)}: no result was recorded.</li>;
  return (
    <li>
      {attemptName(a)}: {a.failedStage ? `failed at ${stage(a.failedStage)}.` : 'a check failed.'}
      {a.excerpt
        ? <details><summary>Output from the failed check</summary><pre className="log">{plain(a.excerpt, 3000)}</pre></details>
        : ' No output was recorded.'}
    </li>
  );
}

export function StepChecks({ events }) {
  const steps = stepChecksSummary(events);
  if (!steps) return null;
  return (
    <section className="step-checks" aria-label="Step checks">
      <h2>Step checks</h2>
      <ul>
        {steps.map((s) => (
          <li key={s.index ?? 'none'}>
            <strong>{stepName(s.index)}</strong>
            <ul>
              {s.attempts.map((a) => <Attempt key={a.seq} a={a} />)}
              {s.outside.map((o) => (
                <li key={o.seq}>
                  Changed {count(o.total, 'file')} outside the plan's list for this step. The reviewer was told; this alone does not fail the step.
                  <FileList entry={o} />
                </li>
              ))}
              {s.protectedFiles.map((p) => (
                <li key={p.seq} className="warn">
                  Changed {count(p.total, 'protected file')}, so this attempt was blocked before review{p.participant ? ` (${plain(p.participant, 64)})` : ''}.
                  <FileList entry={p} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
