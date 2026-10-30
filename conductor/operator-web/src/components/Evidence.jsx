import { plain, shortSha, shownInFull } from '../text.js';

/**
 * The most diff characters shown: the service's whole review payload (1 MiB), so any review it accepts is shown in
 * full and can be inspected before approval (Codex review P04-R1). A longer one is clipped, and diffShownInFull says
 * so, so the approval gate never relies on what happened to be rendered.
 */
export const DIFF_LIMIT = 1024 * 1024;
export const diffShownInFull = (diff) => typeof diff === 'string' && shownInFull(diff, DIFF_LIMIT);

/** A diff as text lines. Never HTML; never turns text into links. */
export function Diff({ diff }) {
  const text = plain(diff, DIFF_LIMIT);
  if (!text.trim()) return <p className="muted">No file changes were reported.</p>;
  const lines = text.split('\n');
  return (
    <pre className="diff" aria-label="Changes" tabIndex={0}>
      {lines.map((line, i) => {
        const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add'
          : line.startsWith('-') && !line.startsWith('---') ? 'del'
            : line.startsWith('diff --git') || line.startsWith('@@') ? 'meta' : '';
        return <span key={i} className={kind}>{line}{'\n'}</span>;
      })}
    </pre>
  );
}

/**
 * The actual test outcome. Only a run that happened and passed is shown as passing;
 * failed, not run, missing or unknown results never look green.
 */
export function Checks({ tests }) {
  let state, title;
  if (!tests || typeof tests !== 'object') { state = 'missing'; title = 'No test report was provided'; }
  else if (tests.ran !== true) { state = 'unrun'; title = 'Tests were not run'; }
  else if (tests.passed === true) { state = 'passed'; title = 'Tests passed'; }
  else if (tests.passed === false) { state = 'failed'; title = `Tests failed${Number.isInteger(tests.code) ? ` (exit code ${tests.code})` : ''}`; }
  else { state = 'unknown'; title = 'Test result unknown'; }
  return (
    <section className={`checks checks-${state}`} aria-label="Checks">
      <h3><span className="dot" aria-hidden="true" /> {title}</h3>
      {state !== 'passed' && <p>Approving now would land work whose checks are not known to pass. Make sure that is what you intend.</p>}
      {tests?.output ? (
        <details>
          <summary>Test output</summary>
          <pre className="log">{plain(tests.output, 100000)}</pre>
        </details>
      ) : null}
    </section>
  );
}

export function Coverage({ coverage }) {
  if (!coverage) return null;
  const local = { used: 'used', 'not-used': 'not used', unknown: 'not known yet' }[coverage.local] ?? 'unknown';
  const vendors = coverage.vendors?.length ? coverage.vendors.map((v) => ({ anthropic: 'Claude (subscription)', openai: 'Codex (subscription)' })[v] ?? plain(v, 40)).join(', ') : 'none yet';
  return (
    <section className="coverage" aria-label="Who did the work">
      <p>Local model: <strong>{local}</strong>. Subscription models that completed calls: <strong>{vendors}</strong>.</p>
      {coverage.weakened && (
        <div className="warn" role="note">
          <p><strong>Review coverage is weaker than planned.</strong></p>
          <ul>{(coverage.reasons?.length ? coverage.reasons : ['No reason was given.']).map((r, i) => <li key={i}>{plain(r, 400)}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

export function ReviewDetails({ review }) {
  if (!review) return null;
  return (
    <section aria-label="Review evidence">
      <p>Reviewed commit <code>{shortSha(review.commit)}</code>{review.files?.length ? ` · ${review.files.length} file${review.files.length === 1 ? '' : 's'} changed` : ''}</p>
      {review.files?.length ? <ul className="files">{review.files.map((f, i) => <li key={i}><code>{plain(f, 300)}</code></li>)}</ul> : null}
      <Checks tests={review.tests} />
      <h3>Changes</h3>
      <Diff diff={review.diff} />
      {review.finalReview || review.council ? (
        <details>
          <summary>Reviewer notes</summary>
          <pre className="log">{plain(JSON.stringify(review.finalReview ?? review.council, null, 2), 50000)}</pre>
        </details>
      ) : null}
    </section>
  );
}
