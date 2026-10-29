// Run event stream: SSE named `run`, explicit `after` cursor, ordered and applied once.
// Losing the stream is reported as "reconnecting", never as success or failure of the run.

export const STREAM = { connecting: 'connecting', live: 'live', reconnecting: 'reconnecting', resync: 'resync', closed: 'closed' };

/** Applies events in sequence order exactly once; returns the new list (or the same one if nothing applied). */
export function applyEvents(current, incoming) {
  let last = current.length ? current[current.length - 1].seq : 0;
  let next = current;
  for (const e of [...incoming].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isInteger(e?.seq) || e.seq <= last) continue; // duplicate delivery: ignore
    if (next === current) next = [...current];
    next.push(e);
    last = e.seq;
  }
  return next;
}

/**
 * Follows a run's events. `onEvent(event)` gets each new event once; `onState(state)` gets
 * stream state changes; on a refused cursor (409) `onResync()` must reload the run snapshot.
 * EventSource reconnects by itself but would replay from the original URL, so the stream is
 * reopened by hand with the largest applied sequence.
 */
export function followRun(runId, { after = 0, onEvent, onState, onResync, EventSourceImpl = globalThis.EventSource, checkCursor, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let cursor = after, source = null, timer = null, closed = false, attempt = 0;
  const open = () => {
    if (closed) return;
    onState?.(attempt ? STREAM.reconnecting : STREAM.connecting);
    source = new EventSourceImpl(`/api/v1/runs/${encodeURIComponent(runId)}/events?after=${cursor}`, { withCredentials: true });
    source.onopen = () => { attempt = 0; onState?.(STREAM.live); };
    source.addEventListener('run', (msg) => {
      let event;
      try { event = JSON.parse(msg.data); } catch { return; }
      if (!Number.isInteger(event?.seq) || event.seq <= cursor) return;
      cursor = event.seq;
      onEvent?.(event);
    });
    source.onerror = async () => {
      source?.close();
      if (closed) return;
      onState?.(STREAM.reconnecting);
      // An EventSource error hides the HTTP status: ask the snapshot whether the cursor is still valid.
      if (checkCursor && !(await checkCursor(cursor).catch(() => true))) { onState?.(STREAM.resync); onResync?.(); return; }
      attempt += 1;
      timer = setTimer(open, Math.min(30000, 500 * 2 ** Math.min(attempt, 6)));
    };
  };
  open();
  return {
    get cursor() { return cursor; },
    close() { closed = true; if (timer) clearTimer(timer); source?.close(); onState?.(STREAM.closed); },
  };
}
