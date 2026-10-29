import { useEffect, useState } from 'react';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { plain, when } from '../text.js';

const ADAPTER = { 'claude-code': 'Claude Code (subscription)', codex: 'Codex (subscription)', 'local-agent': 'Local model' };
const PROBES = [
  { kind: 'installation', label: 'Check installation', note: 'Runs only the version command. No model is contacted.' },
  { kind: 'authenticated', label: 'Check sign-in', note: 'Sends one tiny synthetic request. This uses a little of your subscription allowance (or local model time).' },
  { kind: 'agentic', label: 'Check it can code', note: 'Asks the model to write one file in a throwaway folder. This uses subscription allowance (or local model time).' },
];

/** One check: "verified" only when a real operation proved it; everything else says what is not known. */
function Fact({ label, value }) {
  const text = {
    found: 'found', missing: 'not found', verified: 'verified', required: 'sign-in needed', reachable: 'reachable',
    unreachable: 'not reachable', unknown: 'not checked', 'not-applicable': 'not needed',
  }[value] ?? 'unknown';
  const tone = ['found', 'verified', 'reachable'].includes(value) ? 'ok' : ['missing', 'required', 'unreachable'].includes(value) ? 'bad' : 'unknown';
  return <li className={`fact fact-${tone}`}><span>{label}</span> <strong>{text}</strong></li>;
}

export function Setup({ api }) {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState({ baseUrl: '', model: '' });
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const s = await api.setup();
      setSetup(s);
      setForm({ baseUrl: s.local?.baseUrl ?? '', model: s.local?.model ?? '' });
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const probe = async (participantId, kind) => {
    setBusy(`${participantId}:${kind}`); setError(null);
    try { await api.probe(participantId, kind); await load(); } catch (e) { setError(e); await load().catch(() => {}); } finally { setBusy(null); }
  };

  const save = async (e) => {
    e.preventDefault(); setError(null); setSaved(false);
    const body = { local: { baseUrl: form.baseUrl.trim(), model: form.model.trim() } };
    try {
      await api.validateSetup(body);
      setSetup(await api.saveSetup(body));
      setSaved(true);
    } catch (err) { setError(err); }
  };

  if (!setup) return <section className="panel"><h1>Connections</h1>{error ? <ErrorNote error={error} /> : <p role="status">Loading…</p>}</section>;

  return (
    <section className="panel">
      <h1>Connections</h1>
      <p>Conductor uses your local model for most coding work, and your Claude Code and Codex <em>subscriptions</em> to plan and review. Paid API keys are never used from this app.</p>
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <h2>Signing in to Claude Code and Codex</h2>
      <p>Sign in the normal way in a terminal on this computer (<code>claude</code>, then <code>codex login</code>). This page never asks for passwords, tokens or API keys and cannot receive them. Afterwards, use "Check sign-in" below to confirm it worked.</p>

      <h2>Participants</h2>
      {!setup.configured && <p className="warn">Nothing is configured yet. Enter your local model below to create the default team.</p>}
      <ul className="participants">
        {setup.participants.map((p) => (
          <li key={p.participantId} className="card">
            <h3>{plain(p.participantId, 80)} <span className="muted">— {ADAPTER[p.adapter] ?? plain(p.adapter, 40)}{p.model ? `, ${plain(p.model, 80)}` : ''}</span></h3>
            <ul className="facts">
              <Fact label="Program" value={p.executable} />
              <Fact label="Signed in" value={p.authentication} />
              <Fact label="Model endpoint" value={p.endpoint} />
              <Fact label="Can write code" value={p.agenticExecution} />
            </ul>
            <p className="muted">{p.checkedAt ? `Last checked ${when(p.checkedAt)} (${plain(p.probeKind, 20)} check). Results are history, not a live status.` : 'Not checked since the settings last changed.'}</p>
            {p.reason && <p className="warn">{plain(p.reason, 500)}</p>}
            {p.action && <p><strong>What to do:</strong> {plain(p.action, 500)}</p>}
            <div className="actions">
              {PROBES.map((k) => (
                <button key={k.kind} type="button" disabled={busy !== null} aria-describedby={`probe-${k.kind}`}
                  onClick={() => probe(p.participantId, k.kind)}>
                  {busy === `${p.participantId}:${k.kind}` ? 'Checking…' : k.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <ul className="muted small">{PROBES.map((k) => <li key={k.kind} id={`probe-${k.kind}`}><strong>{k.label}:</strong> {k.note}</li>)}</ul>

      <h2>Local model</h2>
      <form onSubmit={save} className="form">
        <label>Model endpoint (on this computer, or an HTTPS address you already use)
          <input type="url" required value={form.baseUrl} placeholder="http://127.0.0.1:8080/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
        </label>
        <label>Model name, exactly as installed
          <input required maxLength={200} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </label>
        <p className="muted small">Saving changes only these two settings; the rest of your Conductor configuration is kept. Saving makes no model calls. Earlier check results are cleared because they no longer apply.</p>
        <button type="submit">Save local model</button>
        {saved && <p role="status">Saved.</p>}
      </form>

      <h2>Checks used before approval</h2>
      {setup.presets?.map((preset) => (
        <p key={preset.id}>{plain(preset.label, 100)}: {preset.testCommand ? <code>{plain(preset.testCommand, 300)}</code> : <strong className="bad">none configured — runs will have no test evidence</strong>}. Change it in the Conductor configuration file, not here.</p>
      ))}
    </section>
  );
}
