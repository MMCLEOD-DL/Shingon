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
      setError(e);
      if (e instanceof ApiError && (e.code === 'stale-decision' || e.status === 409)) onStale();
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

export function RunView({ api, runId, go }) {
  const [run, setRun] = useState(null);
  const [review, setReview] = useState(null);
  const [events, setEvents] = useState([]);
  const [stream, setStream] = useState(STREAM.connecting);
  const [error, setError] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState(null);
  const follower = useRef(null);
  const eventsRef = useRef([]);

  const refresh = useCallback(async () => {
    try {
      const r = await api.run(runId);
      setRun(r);
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
      {run.status === 'failed' && <div className="outcome bad"><p>The run failed. {run.resumable ? 'You can resume it from its saved work.' : 'It cannot be resumed from here.'} Details are in the activity log below.</p></div>}
      {run.status === 'interrupted' && <div className="outcome bad"><p>The run was interrupted (stopped, or the service restarted). Any question it was asking has been withdrawn. {run.resumable ? 'Resume to continue from its saved work.' : 'It has no saved work to resume.'}</p></div>}
      {run.status === 'paused' && <div className="outcome"><p>Paused. {run.resumable ? 'Resume when ready.' : ''}</p></div>}

      {pending && <Decision api={api} run={run} review={review} onStale={refresh}
        onAnswered={() => { setNotice('Answer saved. Waiting for Conductor to continue — this does not yet mean the work is finished.'); refresh(); }} />}

      <Coverage coverage={run.coverage} />
      {['completed', 'rejected'].includes(run.status) && review && <details><summary>What was reviewed</summary><ReviewDetails review={review} /></details>}

      <div className="actions">
        {active && run.status !== 'cancelling' && (confirmCancel ? (
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
