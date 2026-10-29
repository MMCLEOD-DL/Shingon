import { useEffect, useRef, useState } from 'react';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { newRequestId } from '../api.js';
import { plain } from '../text.js';

export function NewTask({ api, go }) {
  const [repos, setRepos] = useState(null);
  const [repositoryId, setRepositoryId] = useState('');
  const [path, setPath] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [request, setRequest] = useState('');
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  // One id per intended run: a double click or a retry after a lost response cannot start two runs.
  const requestId = useRef(newRequestId());

  const load = async () => {
    try {
      const { repositories } = await api.repositories();
      setRepos(repositories);
      if (!repositoryId && repositories.length) setRepositoryId(repositories[repositories.length - 1].id);
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const register = async (e) => {
    e.preventDefault(); setError(null);
    try {
      const repo = await api.registerRepository(path.trim());
      setConfirming(false); setPath(''); await load(); setRepositoryId(repo.id);
    } catch (err) { setError(err); }
  };

  const start = async (e) => {
    e.preventDefault(); setError(null); setStarting(true);
    try {
      const run = await api.createRun({ repositoryId, request, clientRequestId: requestId.current });
      requestId.current = newRequestId();
      go(`/runs/${run.id}`);
    } catch (err) { setError(err); } finally { setStarting(false); }
  };

  const chosen = repos?.find((r) => r.id === repositoryId);
  return (
    <section className="panel">
      <h1>New coding task</h1>
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <h2>1. Repository</h2>
      {repos === null ? <p role="status">Loading…</p> : repos.length ? (
        <label>Work in
          <select value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)}>
            {repos.map((r) => <option key={r.id} value={r.id}>{plain(r.name, 80)} — {plain(r.path, 300)}</option>)}
          </select>
        </label>
      ) : <p>No repository yet. Add one below.</p>}

      <details open={!repos?.length}>
        <summary>Add a repository</summary>
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (!confirming) setConfirming(true); else register(e); }}>
          <label>Full path of the repository's top folder on this computer
            <input required value={path} onChange={(e) => { setPath(e.target.value); setConfirming(false); }} placeholder="C:\Projects\example" />
          </label>
          {confirming && (
            <p className="warn">Conductor will be allowed to read <code>{plain(path, 300)}</code> and create new branches in it. It never merges or pushes. Press "Add repository" again to confirm.</p>
          )}
          <button type="submit">{confirming ? 'Add repository' : 'Continue'}</button>
        </form>
      </details>

      <h2>2. What should change?</h2>
      <form className="form" onSubmit={start}>
        <label>Describe the change in plain words
          <textarea required rows={6} maxLength={16000} value={request} onChange={(e) => setRequest(e.target.value)} />
        </label>
        <p className="muted small">The work happens in a separate copy. You will see the actual changes and test results before anything lands, and approving only creates a new branch{chosen ? <> in <strong>{plain(chosen.name, 80)}</strong></> : null}.</p>
        <button type="submit" disabled={!repositoryId || !request.trim() || starting}>{starting ? 'Starting…' : 'Start'}</button>
      </form>
    </section>
  );
}
