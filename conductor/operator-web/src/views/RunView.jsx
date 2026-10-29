import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, newRequestId } from '../api.js';
import { applyEvents, followRun, STREAM } from '../events.js';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { Coverage, ReviewDetails } from '../components/Evidence.jsx';
import { plain, shortSha, statusText, when } from '../text.js';

const ACTIVE = new Set(['queued', 'running', 'awaiting-decision', 'cancelling']);
const KIND_TITLE = {
  result: 'Review the finished work',
  plan: 'Approve the plan',
  chunk: 'Approve the next coding step',
  escalation: 'The models disagree: your call',
  fallback: 'The local model is unavailable',
};
const STREAM_TEXT = {
  [STREAM.connecting]: 'Connecting to live progress…',
  [STREAM.live]: 'Live',
  [STREAM.reconnecting]: 'Connection lost — reconnecting. The run itself is unaffected; nothing is answered while you are away.',
  [STREAM.resync]: 'Progress view reloaded from the service.',
  [STREAM.closed]: '',
};

function Decision({ api, run, review, onAnswered, onStale }) {
  const d = run.decision;
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState(false);
  const heading = useRef(null);
  // One request id per decision: retrying after a lost response is answered from the service's receipt.
  const requestId = useRef({ decision: null, id: null });
  if (requestId.current.decision !== d.id) requestId.current = { decision: d.id, id: newRequestId() };

  useEffect(() => { heading.current?.focus(); }, [d.id]);

  const answer = async (choiceId) => {
    setError(null); setSending(choiceId);
    try {
      await api.answer(run.id, d.id, {
        choiceId, expectedRevision: d.revision, reviewedCommit: d.evidence?.commit ?? null,
        clientRequestId: requestId.current.id, feedback: d.kind === 'result' && choiceId === 'reject' && feedback.trim() ? feedback.trim() : undefined,
      });
      setSent(true);
      onAnswered(choiceId);
    } catch (e) {
      // A refused (stale) answer is reported by the run view: reloading may remove this panel, and the
      // operator must still see that their answer did not count.
      if (e instanceof ApiError && (e.code === 'stale-decision' || e.status === 409)) onStale(e);
      else setError(e);
    } finally { setSending(null); }
  };

  const needsEvidence = d.kind === 'result';
  const evidenceShown = !needsEvidence || (review && review.commit === d.evidence?.commit);
  return (
    <section className="decision" aria-labelledby="decision-title">
      <h2 id="decision-title" tabIndex={-1} ref={heading}>{KIND_TITLE[d.kind] ?? 'A decision is needed'}</h2>
      <p className="prompt">{plain(d.prompt, 4000)}</p>
      {d.kind === 'fallback' && <p>Continuing uses your Claude Code and Codex subscriptions for the work the local model would have done. It never switches to paid API keys.</p>}
      {needsEvidence && (evidenceShown ? <ReviewDetails review={review} /> : <p className="warn" role="status">Loading the exact changes and test results for commit <code>{shortSha(d.evidence?.commit)}</code>… Approval stays unavailable until they are shown.</p>)}
      {needsEvidence && (
        <label>If you reject, what should change? (optional, kept with the run)
          <textarea rows={3} maxLength={2000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        </label>
      )}
      <ErrorNote error={error} />
      {sent ? <p role="status">Answer saved. Waiting for Conductor to continue — this does not yet mean the work is finished.</p> : (
        <div className="choices">
          {d.choices.map((c) => (
            <div key={c.id} className="choice">
              <button type="button" className={c.id === 'approve' || c.id === 'continue' ? 'primary' : ''}
                disabled={sending !== null || (c.id === 'approve' && !evidenceShown)} onClick={() => answer(c.id)}>
                {sending === c.id ? 'Sending…' : (d.kind === 'result' && c.id === 'approve' ? 'Approve: create a branch' : plain(c.label, 60))}
              </button>
              <span className="consequence">{plain(c.consequence, 300)}</span>
            </div>
          ))}
        </div>
      )}
      {d.kind === 'result' && <p className="muted small">Approving creates a new branch from commit <code>{shortSha(d.evidence?.commit)}</code>. Nothing is merged, pushed or deployed.</p>}
    </section>
  );
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAY_HAVE_LANDED = 'The approved result may already be in the repository. Inspect its branches before recovering this run; automatic resume is disabled.';

// After an uncertain landing: the operator inspects the repository, then records that they did. Recording starts
// nothing and changes no branches; Resume stays a separate step. The confirmation is bound to the snapshot it was
// given against, so a newer snapshot clears it and needs a fresh look.
function Recovery({ api, run, repositoryPath, onRecorded, onRefused }) {
  const [inspectedFor, setInspectedFor] = useState(null); // the snapshot the confirmation was given against
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const commit = FULL_SHA.test(run.workspaceCommit ?? '') ? run.workspaceCommit : null;
  const snapshot = `${run.lastEventSeq}:${commit}`;
  // One request id per snapshot: retrying after a lost response is answered from the service's receipt.
  const requestId = useRef({ snapshot: null, id: null });
  if (requestId.current.snapshot !== snapshot) requestId.current = { snapshot, id: newRequestId() };
  const inspected = inspectedFor === snapshot;

  const record = async () => {
    setError(null); setSending(true);
    try {
      await api.recover(run.id, { clientRequestId: requestId.current.id, repositoryInspected: true, expectedEventSeq: run.lastEventSeq, reviewedCommit: commit });
      onRecorded();
    } catch (e) {
      // A refusal means the run changed or no longer qualifies: the run view reports it and reloads.
      if (e instanceof ApiError && e.status === 409) onRefused(e);
      else setError(e);
    } finally { setSending(false); }
  };

  const repo = repositoryPath ? plain(repositoryPath, 500) : '<repository folder>';
  // Never put a path a shell would expand or split into a command meant to be copied.
  const quoted = repositoryPath && !/["$`\r\n]/.test(repositoryPath) ? repo : '<repository folder>';
  return (
    <section className="decision recovery" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Check the repository before recovering</h2>
      <p>Conductor lost contact with its worker after you approved this result, so it cannot tell whether the branch was created. Resume stays off until you have looked.</p>
      {!commit ? <p className="warn">No approved commit is recorded for this run, so it cannot be recovered from here. Keep the repository as it is and follow the command-line recovery steps in the setup guide.</p> : (
        <>
          <ol>
            <li>In the repository <code>{repo}</code>, look for a branch at the approved commit <code>{commit}</code>. These commands only read:
              <pre className="log">{`git -C "${quoted}" status --short\ngit -C "${quoted}" branch --list "conductor/*"\ngit -C "${quoted}" branch --points-at ${commit}`}</pre>
            </li>
            <li>Check that branch&apos;s changes too: a similar name alone does not prove it holds the approved result. Do not delete branches or start the same task again, and leave any other work in the repository as it is.</li>
          </ol>
          <label className="check">
            <input type="checkbox" checked={inspected} onChange={(e) => setInspectedFor(e.target.checked ? snapshot : null)} />
            {' '}I have inspected the repository&apos;s branches for commit <code>{shortSha(commit)}</code>
          </label>
          <ErrorNote error={error} />
          <div className="choices">
            <div className="choice">
              <button type="button" className="primary" disabled={!inspected || sending} onClick={record}>{sending ? 'Recording…' : 'Record inspection'}</button>
              <span className="consequence">This only records that you looked. It starts nothing and changes no branches. Resume is a separate step afterwards.</span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function RunView({ api, runId, go }) {
  const [run, setRun] = useState(null);
  const [review, setReview] = useState(null);
  const [events, setEvents] = useState([]);
  const [stream, setStream] = useState(STREAM.connecting);
  const [error, setError] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState(null);
  const [repositoryPath, setRepositoryPath] = useState(null);
  // After an answer is accepted, the shown snapshot is out of date until the next one arrives: offer no actions from it.
  const [answered, setAnswered] = useState(false);
  const answeredAt = useRef(null); // lastEventSeq when the answer was accepted
  const follower = useRef(null);
  const eventsRef = useRef([]);

  const refresh = useCallback(async () => {
    try {
      const r = await api.run(runId);
      setRun(r);
      // A snapshot taken before the service recorded the answer must not bring the old question or Stop back.
      if (answeredAt.current === null || r.lastEventSeq > answeredAt.current) { answeredAt.current = null; setAnswered(false); }
      if (r.decision?.kind === 'result' || ['completed', 'rejected'].includes(r.status)) {
        try { setReview(await api.review(runId)); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) setError(e); }
      }
      return r;
    } catch (e) { setError(e); return null; }
  }, [api, runId]);

  // Snapshot first, then the stream from the beginning (replay is cheap and bounded); status always comes from the snapshot.
  useEffect(() => {
    let stopped = false;
    const start = (after) => {
      follower.current?.close();
      follower.current = followRun(runId, {
        after,
        onEvent: (e) => {
          eventsRef.current = applyEvents(eventsRef.current, [e]);
          setEvents(eventsRef.current);
          if (e.type !== 'progress') refresh();
        },
        onState: (s) => { if (!stopped) setStream(s); },
        checkCursor: async (cursor) => { const r = await api.run(runId); return cursor <= r.lastEventSeq; },
        onResync: async () => { eventsRef.current = []; setEvents([]); await refresh(); start(0); },
      });
    };
    refresh().then((r) => { if (r && !stopped) start(0); });
    return () => { stopped = true; follower.current?.close(); };
  }, [api, runId, refresh]);

  // The inspection steps name the registered repository folder; without it they still work with a placeholder.
  const needsInspection = Boolean(run?.recoveryRequired);
  const repositoryId = run?.repositoryId;
  useEffect(() => {
    if (!needsInspection || !repositoryId) return undefined;
    let current = true;
    api.repositories().then((r) => {
      const repo = r?.repositories?.find?.((x) => x.id === repositoryId);
      if (current && typeof repo?.path === 'string') setRepositoryPath(repo.path);
    }, () => {});
    return () => { current = false; };
  }, [api, needsInspection, repositoryId]);

  const cancel = async () => {
    setError(null);
    try {
      const r = await api.cancel(runId);
      setNotice(r.requested ? 'Stop requested. Conductor will show "Interrupted" once the worker has actually stopped.' : `Nothing to stop: the run is ${statusText(r.status).toLowerCase()}.`);
      setConfirmCancel(false); await refresh();
    } catch (e) { setError(e); }
  };
  const resume = async () => {
    setError(null);
    try { await api.resume(runId); setNotice('Resumed. Earlier answers do not carry over: you will be asked again on fresh evidence.'); await refresh(); } catch (e) { setError(e); }
  };

  if (!run) return <section className="panel">{error ? <ErrorNote error={error} /> : <p role="status">Loading run…</p>}</section>;
  const active = ACTIVE.has(run.status);
  const last = events.length ? events[events.length - 1] : null;
  const pending = run.status === 'awaiting-decision' && run.decision?.status === 'pending' ? run.decision : null;

  return (
    <section className="panel">
      <p><a href="/history" onClick={(e) => { e.preventDefault(); go('/history'); }}>← History</a></p>
      <h1>{plain(run.title, 200) || 'Run'}</h1>
      <p className={`status status-${plain(run.status, 30)}`} role="status" aria-live="polite">
        <strong>{statusText(run.status)}</strong>
        {active && run.phase ? <> — {plain(run.phase, 80)}</> : null}
      </p>
      {active && !pending && last && <p>{plain(last.message, 500)}{last.participant ? <span className="muted"> ({plain(last.participant, 60)})</span> : null}</p>}
      {active && STREAM_TEXT[stream] && <p className={stream === STREAM.live ? 'muted small' : 'warn'}>{STREAM_TEXT[stream]}</p>}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {notice && <p role="status" className="notice">{notice}</p>}

      {run.status === 'completed' && (
        <div className="outcome ok">
          {run.landedBranch
            ? <p>Branch <code>{plain(run.landedBranch, 200)}</code> was created in the repository. Nothing was merged, pushed or deployed.</p>
            : <p className="warn">The run finished, but the service did not report a branch name. Check the repository before relying on it.</p>}
        </div>
      )}
      {run.status === 'rejected' && <div className="outcome"><p>Rejected. No branch was created and your repository was not changed.</p></div>}
      {run.status === 'failed' && <div className="outcome bad"><p>The run failed. {run.recoveryRequired ? MAY_HAVE_LANDED : run.resumable ? 'You can resume it from its saved work.' : 'It cannot be resumed from here.'} Details are in the activity log below.</p></div>}
      {run.status === 'interrupted' && <div className="outcome bad"><p>The run was interrupted (stopped, or the service restarted). Any question it was asking has been withdrawn. {run.recoveryRequired ? MAY_HAVE_LANDED : run.resumable ? 'Resume to continue from its saved work.' : 'It has no saved work to resume.'}</p></div>}
      {!active && !run.recoveryRequired && run.resumable && run.landingPending && run.recoveryAcknowledged && (
        <p className="notice">You recorded your repository inspection on {when(run.recoveryAcknowledged.at)}. Resume lets Conductor check whether the approved result reached the repository; if it did not, you will be asked to review it again.</p>
      )}
      {!active && run.recoveryRequired && ['interrupted', 'failed'].includes(run.status) && (
        <Recovery api={api} run={run} repositoryPath={repositoryPath} onRefused={(e) => { setError(e); refresh(); }}
          onRecorded={() => { setError(null); setNotice('Inspection recorded. Nothing has started and no branch was changed. Resume when you are ready.'); refresh(); }} />
      )}
      {run.status === 'paused' && <div className="outcome"><p>Paused. {run.resumable ? 'Resume when ready.' : ''}</p></div>}

      {pending && !answered && <Decision api={api} run={run} review={review} onStale={(e) => { setError(e); refresh(); }}
        onAnswered={() => { answeredAt.current = run.lastEventSeq; setAnswered(true); setNotice('Answer saved. Waiting for Conductor to continue — this does not yet mean the work is finished.'); refresh(); }} />}

      <Coverage coverage={run.coverage} />
      {['completed', 'rejected'].includes(run.status) && review && <details><summary>What was reviewed</summary><ReviewDetails review={review} /></details>}

      <div className="actions">
        {active && run.landingPending && <p className="warn">Adding the approved result to the repository. Wait for its outcome; it is no longer safe to stop this step.</p>}
        {active && !answered && !run.landingPending && run.status !== 'cancelling' && (confirmCancel ? (
          <>
            <button type="button" className="danger" onClick={cancel}>Yes, stop this run</button>
            <button type="button" onClick={() => setConfirmCancel(false)}>Keep running</button>
          </>
        ) : <button type="button" onClick={() => setConfirmCancel(true)}>Stop run…</button>)}
        {!active && run.resumable && ['interrupted', 'paused', 'failed'].includes(run.status) && <button type="button" onClick={resume}>Resume</button>}
      </div>

      <details className="activity">
        <summary>Activity log ({events.length})</summary>
        <ol>
          {events.map((e) => (
            <li key={e.seq}><span className="muted">{when(e.at)}</span> {plain(e.message, 1000)}{e.participant ? <span className="muted"> — {plain(e.participant, 60)}</span> : null}</li>
          ))}
        </ol>
      </details>
      <p className="muted small">Started {when(run.createdAt)} · Commit under review {shortSha(run.workspaceCommit)}</p>
    </section>
  );
}
