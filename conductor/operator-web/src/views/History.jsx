import { useEffect, useState } from 'react';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { plain, statusText, when } from '../text.js';

export function History({ api, go }) {
  const [runs, setRuns] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = async (cursor) => {
    try {
      const page = await api.runs(cursor);
      setRuns((prev) => (cursor ? [...(prev ?? []), ...page.runs] : page.runs));
      setNext(page.nextCursor);
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resume = async (id) => {
    setBusy(id); setError(null);
    try { await api.resume(id); go(`/runs/${id}`); } catch (e) { setError(e); } finally { setBusy(null); }
  };

  return (
    <section className="panel">
      <h1>History</h1>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {runs === null ? <p role="status">Loading…</p> : runs.length === 0 ? <p>No runs yet.</p> : (
        <table className="runs">
          <thead><tr><th scope="col">Task</th><th scope="col">State</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td><a href={`/runs/${r.id}`} onClick={(e) => { e.preventDefault(); go(`/runs/${r.id}`); }}>{plain(r.title, 120) || 'Untitled'}</a></td>
                <td><span className={`status status-${plain(r.status, 30)}`}>{statusText(r.status)}</span>{r.landedBranch ? <> · <code>{plain(r.landedBranch, 200)}</code></> : null}</td>
                <td>{when(r.updatedAt)}</td>
                <td>{r.resumable && ['interrupted', 'paused', 'failed'].includes(r.status) ? (
                  <button type="button" disabled={busy !== null} onClick={() => resume(r.id)}>{busy === r.id ? 'Resuming…' : 'Resume'}</button>
                ) : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && <button type="button" onClick={() => load(next)}>Show older runs</button>}
      <p className="muted small">Resume continues from the work already saved; finished steps are not repeated, and any approval must be given again on fresh evidence.</p>
    </section>
  );
}
