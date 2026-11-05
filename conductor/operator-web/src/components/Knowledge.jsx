// K8: what the company knowledge base did in this run, for the operator only (design note §6). Built from the evidence-*
// progress events the service forwards (docs/operator-app/interface.md): counts, collections, allowed destinations
// and reasons. It never shows a passage; the engine never sends one to the service.
import { plain } from '../text.js';

const DESTINATION = {
  'local-model': 'the local model',
  'claude-subscription': 'Claude (subscription)',
  'codex-subscription': 'Codex (subscription)',
};
const destinationText = (d) => {
  const app = /^foundation-app:([a-z0-9][a-z0-9-]{0,63})$/.exec(d);
  return DESTINATION[d] ?? (app ? `the Foundation app “${app[1]}”` : plain(d, 80));
};
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const documents = (n) => `${n} document${n === 1 ? '' : 's'}`;

// The engine's reason codes when the knowledge base could not be used at all (knowledge/client.js KbError codes).
const UNAVAILABLE = {
  config: 'the knowledge-base settings or its token are missing or not valid',
  unreachable: 'the knowledge service could not be reached',
  timeout: 'the knowledge service did not answer in time',
  redirect: 'the knowledge service answered with a redirect, which is never followed',
  'bad-response': 'the knowledge service sent an answer Conductor could not accept',
  'too-large': 'the knowledge service sent an answer that was too large',
  'not-for-this-run': 'this kind of run does not use the knowledge base',
};

/** The operator's summary of one run's knowledge-base events, or null when the run has none. */
export function knowledgeSummary(events) {
  const kb = (events ?? []).filter((e) => e?.type === 'progress' && /^evidence-/.test(e?.data?.engineType ?? ''));
  if (!kb.length) return null;
  const used = kb.find((e) => e.data.engineType === 'evidence-used')?.data ?? null;
  const withheld = new Map(); // one line per collection: who it was kept from, and where it may go
  for (const { data } of kb.filter((e) => e.data.engineType === 'evidence-withheld')) {
    const r = data.report;
    const collection = plain(r?.collectionId ?? data.collectionId, 200);
    if (!collection) continue;
    const entry = withheld.get(collection) ?? { collection, from: [], allowed: [], documentIds: [], documents: 0 };
    if (r) {
      const who = plain(r.participant, 64);
      if (who && !entry.from.includes(who)) entry.from.push(who);
      for (const d of r.allowedDestinations ?? []) if (!entry.allowed.includes(d)) entry.allowed.push(d);
      for (const id of r.documentIds ?? []) if (!entry.documentIds.includes(id)) entry.documentIds.push(id);
    } else if (Number.isSafeInteger(data.documents)) {
      entry.documents = Math.max(entry.documents, data.documents);
    }
    withheld.set(collection, entry);
  }
  const last = (type) => [...kb].reverse().find((e) => e.data.engineType === type)?.data ?? null;
  return { used, withheld: [...withheld.values()], dropped: last('evidence-dropped'), stopped: last('evidence-stopped'), unavailable: last('evidence-unavailable') };
}

export function KnowledgeNote({ events }) {
  const s = knowledgeSummary(events);
  if (!s) return null;
  const lines = [];
  if (s.unavailable) {
    const why = UNAVAILABLE[s.unavailable.reason] ?? (s.unavailable.reason ? `reason: ${plain(s.unavailable.reason, 200)}` : 'no reason was given');
    lines.push(<li key="unavailable">The knowledge base was not used: {why}. The run carried on without it.</li>);
  }
  if (s.used) {
    const n = Number.isSafeInteger(s.used.count) ? s.used.count : null;
    lines.push(<li key="used">{n ? `${n} passage${n === 1 ? '' : 's'}` : 'Passages'} from the knowledge base {n === 1 ? 'was' : 'were'} given to the models{s.used.evidence === 'weak' ? '. The knowledge base rated this evidence as weak' : ''}.</li>);
  }
  for (const w of s.withheld) {
    const count = w.documentIds.length || w.documents;
    const what = count ? documents(count) : 'Documents';
    if (w.allowed.length) {
      lines.push(
        <li key={`w-${w.collection}`}>
          {what} from <strong>{w.collection}</strong> {count === 1 ? 'was' : 'were'} kept from {w.from.length ? list(w.from) : 'this run'}: that collection may go only to {list(w.allowed.map(destinationText))}. To use {count === 1 ? 'it' : 'them'}, run the task with only those participants.
          {w.documentIds.length ? (
            <details><summary>Which documents</summary><ul>{w.documentIds.map((id) => <li key={id}><code>{plain(id, 300)}</code></li>)}</ul></details>
          ) : null}
        </li>,
      );
    } else {
      lines.push(<li key={`w-${w.collection}`}>{what} from <strong>{w.collection}</strong> {count === 1 ? 'was' : 'were'} kept from every model: that collection allows no destination this run can use.</li>);
    }
  }
  if (s.dropped) lines.push(<li key="dropped">Evidence was dropped before any was used, and the run carried on without it{s.dropped.reason ? `: ${plain(s.dropped.reason, 300)}` : ''}.</li>);
  if (s.stopped) {
    lines.push(
      <li key="stopped" className="warn">
        The run was stopped so that nothing built from the evidence was passed on{s.stopped.reason ? ` (${plain(s.stopped.reason, 300)})` : ''}. Resume once the knowledge service is reachable and its policy is unchanged, or start a fresh run.
      </li>,
    );
  }
  return (
    <section className="knowledge" aria-label="Knowledge base">
      <h2>Knowledge base</h2>
      <ul>{lines}</ul>
    </section>
  );
}
