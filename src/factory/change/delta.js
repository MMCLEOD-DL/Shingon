// What changed between the brief an app was built from and a newly approved one (Plan 11, Task 3).
// Pure: no files, no git. Features and examples are matched by id (Contract 7.4), so reordering
// a brief never counts as a change. The delta feeds runBuild's change mode as Plan 8 units.

import { EXAMPLE_ID_RE, testTag } from '../acceptance.js';
import { MAX_INSTRUCTIONS } from '../split.js';
import { OUTBOUND_SERVICES } from '../outbound.js';

export const NOTHING_TO_BUILD = 'The new brief does not change anything the app does, so there is nothing to build. The new brief version is kept.';
export const KIND_CHANGED = 'The new brief describes a different kind of software. That is a new project, not a change: start it with "conductor project new".';
export const HOSTING_CHANGED = 'The new brief moves where the app runs. That needs a new deployment (conductor ship), not a change request, so nothing was built.';
export const OPERATOR_ACCESS_REQUIRED = 'The new brief no longer gives you remote access for support. Every Highland deployment needs it (spec §4.6), so nothing was built. Revise the brief first.';
export const EXAMPLE_ID_INVALID = (list) => `The brief has worked examples whose numbers are missing, repeated or filed under the wrong feature (${list.join(', ')}), so Conductor cannot tell which tests prove them. Nothing was built. Approve the brief again with this version of Conductor.`;
export const EXAMPLE_ID_REUSED = (ids) => `The new brief changed the words of worked examples that kept their old numbers (${ids.join(', ')}), so Conductor cannot tell which tests prove them. Nothing was built. Revise the brief again so each changed example gets a new number.`;

const FEATURE_FIELDS = ['title', 'story', 'roles', 'data', 'acceptance'];
const FIELD_WORDS = { title: 'its name', story: 'what it does', roles: 'who uses it', data: 'its records', acceptance: 'its worked examples' };

// ---- comparison ----

// Canonical JSON: keys sorted recursively; lists of plain values sorted (their order never counts).
function canon(v) {
  if (Array.isArray(v)) {
    const items = v.map(canon);
    return items.every((x) => x === null || typeof x !== 'object') ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, canon(v[k])]));
  }
  return v;
}
const same = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
const words = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const exampleWords = (e) => JSON.stringify([words(e?.given), words(e?.when), words(e?.then)]);
const idNumber = (id) => Number(EXAMPLE_ID_RE.exec(id)?.[2] ?? 0);
const byNumber = (a, b) => idNumber(a) - idNumber(b);
const exampleMap = (f) => new Map((f?.acceptance ?? []).filter((e) => typeof e?.id === 'string').map((e) => [e.id, e]));

function diffByKey(before = [], after = [], key) {
  const b = new Map(before.map((x) => [key(x), x]));
  const a = new Map(after.map((x) => [key(x), x]));
  return {
    added: after.filter((x) => !b.has(key(x))),
    removed: before.filter((x) => !a.has(key(x))),
    both: after.filter((x) => b.has(key(x))).map((x) => [b.get(key(x)), x]),
  };
}

export function briefDelta(prev, next) {
  const reused = new Set();
  const f = diffByKey(prev.features, next.features, (x) => x.id);
  const changed = [];
  for (const [before, after] of f.both) {
    const fields = FEATURE_FIELDS.filter((k) => {
      if (k === 'acceptance') {
        const bi = [...exampleMap(before).keys()].sort(), ai = [...exampleMap(after).keys()].sort();
        return !same(bi, ai);
      }
      return !same(before[k], after[k]);
    });
    const bm = exampleMap(before), am = exampleMap(after);
    for (const [id, e] of am) if (bm.has(id) && exampleWords(bm.get(id)) !== exampleWords(e)) reused.add(id);
    if (fields.length === 0) continue;
    changed.push({
      before, after, fields,
      examples: {
        added: [...am.keys()].filter((id) => !bm.has(id)).sort(byNumber),
        retired: [...bm.keys()].filter((id) => !am.has(id)).sort(byNumber),
      },
    });
  }
  const r = diffByKey(prev.roles, next.roles, (x) => x.name);
  const roleChanged = r.both.filter(([b, a]) => !same(b, a)).map(([before, after]) => ({ before, after }));
  const ident = (x) => JSON.stringify(canon(x));
  const o = diffByKey(prev.outputs, next.outputs, ident);
  const i = diffByKey(prev.integrations, next.integrations, ident);
  const pm = new Set(prev.modules ?? []), nm = new Set(next.modules ?? []);
  const pp = prev.policy ?? {}, np = next.policy ?? {};
  const policy = [...new Set([...Object.keys(pp), ...Object.keys(np)])].sort()
    .filter((field) => !same(pp[field], np[field]))
    .map((field) => ({ field, before: pp[field] ?? null, after: np[field] ?? null }));
  const identity = ['client', 'purpose', 'kind'].filter((field) => !same(prev[field], next[field]))
    .map((field) => ({ field, before: prev[field] ?? null, after: next[field] ?? null }));
  const delta = {
    fromVersion: prev.version, toVersion: next.version,
    features: { added: f.added, changed, removed: f.removed },
    roles: { added: r.added, removed: r.removed, changed: roleChanged },
    outputs: { added: o.added, removed: o.removed },
    integrations: { added: i.added, removed: i.removed },
    modules: { added: [...nm].filter((m) => !pm.has(m)), removed: [...pm].filter((m) => !nm.has(m)) },
    policy, identity,
    order: (next.features ?? []).map((x) => x.id),
    reusedIds: [...reused].sort(byNumber),
    empty: false,
  };
  delta.empty = f.added.length + changed.length + f.removed.length === 0
    && r.added.length + r.removed.length + roleChanged.length === 0
    && o.added.length + o.removed.length + i.added.length + i.removed.length === 0
    && delta.modules.added.length + delta.modules.removed.length === 0
    && policy.length === 0
    && !identity.some((x) => x.field === 'kind' || x.field === 'client');
  return delta;
}

// Example ids that are missing, malformed, repeated or filed under another feature's name.
export function invalidExampleIds(brief) {
  const bad = [];
  const seen = new Set();
  for (const f of brief?.features ?? []) {
    (f.acceptance ?? []).forEach((e, i) => {
      const m = typeof e?.id === 'string' ? EXAMPLE_ID_RE.exec(e.id) : null;
      if (!m || m[1] !== f.id || seen.has(e.id)) bad.push(typeof e?.id === 'string' ? e.id : `${f.id}, example ${i + 1}`);
      if (typeof e?.id === 'string') seen.add(e.id);
    });
  }
  return bad;
}

export function deltaProblem(delta, prev, next) {
  const invalid = [...new Set([...invalidExampleIds(prev), ...invalidExampleIds(next)])];
  if (invalid.length) return EXAMPLE_ID_INVALID(invalid);
  if (delta.reusedIds.length) return EXAMPLE_ID_REUSED(delta.reusedIds);
  if (delta.empty) return NOTHING_TO_BUILD;
  if (delta.identity.some((x) => x.field === 'kind')) return KIND_CHANGED;
  if (delta.policy.some((x) => x.field === 'hosting')) return HOSTING_CHANGED;
  const was = prev?.policy?.operatorAccess, now = next?.policy?.operatorAccess;
  if (now === false || (was === true && now !== true)) return OPERATOR_ACCESS_REQUIRED;
  return null;
}

export function profileChanged(delta) {
  return delta.modules.added.length > 0 || delta.modules.removed.length > 0
    || delta.policy.some((p) => p.field === 'outbound' || p.field === 'residency');
}

// ---- plain English ----

const POLICY_WORDS = {
  hosting: 'Where it runs', outbound: 'Outside services allowed', residency: 'Where data may be kept',
  retention: 'How long data is kept', backupDestination: 'Backups', operatorAccess: 'Your remote access for support',
};
const HOSTING_NAMES = { 'client-box': "the client's own computer", 'operator-server': 'a server you run' };
const RESIDENCY_NAMES = { uk: 'UK only', 'uk-eu': 'UK or EU', any: 'anywhere' };

function policyValue(field, v) {
  if (v === null || v === undefined) return 'not decided';
  if (field === 'outbound') return v.length ? v.map((id) => OUTBOUND_SERVICES[id]?.label ?? id).join(', ') : 'none';
  if (field === 'hosting') return HOSTING_NAMES[v] ?? String(v);
  if (field === 'residency') return RESIDENCY_NAMES[v] ?? String(v);
  if (field === 'retention') return v.text ?? (v.days != null ? `${v.days} days` : 'not decided');
  if (field === 'backupDestination') return [v.kind, v.detail].filter(Boolean).join(': ') || 'not decided';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return typeof v === 'string' ? v : JSON.stringify(v);
}
const policyLine = ({ field, before, after }) => `${POLICY_WORDS[field] ?? field}: ${policyValue(field, before)} → ${policyValue(field, after)}`;

export function deltaText(delta) {
  const lines = [];
  const titles = (list) => list.map((f) => f.title).join(', ');
  if (delta.features.added.length) lines.push(`Added: ${titles(delta.features.added)}.`);
  if (delta.features.changed.length) {
    lines.push(`Changed: ${delta.features.changed.map((c) => `${c.after.title} (${c.fields.map((k) => FIELD_WORDS[k]).join(', ')})`).join(', ')}.`);
  }
  if (delta.features.removed.length) lines.push(`Removed: ${delta.features.removed.map((f) => `${f.title} (its data is kept)`).join(', ')}.`);
  const part = (label, list) => (list.length ? `${label} ${list.join(', ')}` : null);
  const group = (name, parts) => { const p = parts.filter(Boolean); if (p.length) lines.push(`${name}: ${p.join('; ')}.`); };
  group('Roles', [part('added', delta.roles.added.map((x) => x.name)), part('removed', delta.roles.removed.map((x) => x.name)),
    part('changed', delta.roles.changed.map((x) => x.after.name))]);
  group('Outputs', [part('added', delta.outputs.added.map((x) => x.name)), part('removed', delta.outputs.removed.map((x) => x.name))]);
  group('Integrations', [part('added', delta.integrations.added.map((x) => x.name)), part('removed', delta.integrations.removed.map((x) => x.name))]);
  group('Modules', [part('added', delta.modules.added), part('removed', delta.modules.removed)]);
  if (delta.policy.length) lines.push(`Data policy changes:\n${delta.policy.map((p) => `  - ${policyLine(p)}`).join('\n')}`);
  const idLines = delta.identity.filter((x) => x.field !== 'kind').map((x) => `${x.field === 'client' ? 'Client name' : 'Purpose'} changed.`);
  lines.push(...idLines);
  return lines.join('\n');
}

export function changeChangelogLines(delta, toVersion) {
  const names = (list) => list.map((f) => f.title).join(', ');
  const parts = [];
  if (delta.features.added.length) parts.push(`added ${names(delta.features.added)}`);
  if (delta.features.changed.length) parts.push(`changed ${delta.features.changed.map((c) => c.after.title).join(', ')}`);
  if (delta.features.removed.length) parts.push(`removed ${names(delta.features.removed)}`);
  if (parts.length === 0) parts.push('brief-wide changes');
  return [`- Change (brief v${toVersion}): ${parts.join('; ')}.`];
}

// ---- build units ----

const tags = (ids) => ids.map(testTag).join(', ');

// Join sentences; the quoted old story (the only free-length part) is shortened first to fit.
function fit(head, story, tail) {
  const room = MAX_INSTRUCTIONS - head.length - tail.length - 1;
  if (room < 0) return [head, tail].filter(Boolean).join(' ');
  let s = story;
  if (s.length > room) s = `${s.slice(0, Math.max(0, room - 1))}…`;
  return [head + s, tail].filter(Boolean).join(' ');
}

function briefWideSentences(delta) {
  const out = [];
  for (const r of delta.roles.added) out.push(`Add the role "${r.name}" (it works like a ${r.mapsTo}).`);
  for (const r of delta.roles.removed) out.push(`Remove the role "${r.name}".`);
  for (const { before, after } of delta.roles.changed) {
    const what = [];
    if (!same(before.whatTheyDo, after.whatTheyDo)) what.push(`what they do (now: ${words(after.whatTheyDo)})`);
    if (!same(before.sees, after.sees)) what.push(`what they see (now: ${words(after.sees)})`);
    if (!same(before.mapsTo, after.mapsTo)) what.push(`their access level (it was ${before.mapsTo}, now ${after.mapsTo})`);
    out.push(`The role "${after.name}" changed: ${what.join('; ') || 'its details'}.`);
  }
  for (const x of delta.identity) {
    if (x.field === 'client') out.push(`The client's name changed from "${x.before}" to "${x.after}": update it wherever the app shows it.`);
    if (x.field === 'purpose') out.push(`The app's stated purpose changed from "${x.before}" to "${x.after}": update any text that describes it.`);
  }
  for (const x of delta.outputs.added) out.push(`Add the output "${x.name}" (${x.format}).`);
  for (const x of delta.outputs.removed) out.push(`Remove the output "${x.name}".`);
  for (const x of delta.integrations.added) out.push(`Add the integration "${x.name}".`);
  for (const x of delta.integrations.removed) out.push(`Remove the integration "${x.name}".`);
  for (const m of delta.modules.added) out.push(`Add the module ${m}.`);
  for (const m of delta.modules.removed) out.push(`Remove the module ${m}.`);
  for (const p of delta.policy) out.push(`Data policy: ${policyLine(p)}.`);
  return out;
}

export function buildUnits(delta, { toVersion } = {}) {
  for (const f of [...delta.features.added, ...delta.features.removed, ...delta.features.changed.flatMap((c) => [c.before, c.after])]) {
    const bad = invalidExampleIds({ features: [f] });
    if (bad.length) throw new Error(EXAMPLE_ID_INVALID(bad));
  }
  const units = [];
  const addedIds = new Set(delta.features.added.map((f) => f.id));
  const changedBy = new Map(delta.features.changed.map((c) => [c.after.id, c]));
  const byId = new Map(delta.features.added.map((f) => [f.id, f]));
  // Added and changed features follow the new brief's feature order.
  const order = delta.order ?? [...delta.features.changed.map((c) => c.after.id), ...delta.features.added.map((f) => f.id)];
  for (const id of order) {
    if (addedIds.has(id)) {
      const f = byId.get(id);
      units.push({
        id: f.id, title: f.title, covers: [f.id], acceptance: (f.acceptance ?? []).map((e) => e.id), kind: 'feature',
        dependsOn: [], instructions: `New in brief v${toVersion}. Build this feature as the brief describes it.`,
        change: 'added', retire: [],
      });
    } else if (changedBy.has(id)) {
      const { after, before, fields, examples } = changedBy.get(id);
      const head = `What changed: ${fields.map((k) => FIELD_WORDS[k]).join(', ')}. Before: `;
      const tail = examples.retired.length
        ? `Tests tagged ${tags(examples.retired)} prove an example the client no longer wants: change or remove those tests only.` : '';
      // The "." after the quoted story is part of what gets shortened to fit.
      const instructions = fit(head, `${words(before.story)}.`, tail);
      units.push({
        id: `change-${after.id}`, title: `Change ${after.title}`, covers: [after.id], acceptance: examples.added,
        kind: examples.added.length ? 'feature' : 'fix', dependsOn: [], instructions,
        change: 'changed', retire: examples.retired,
      });
    }
  }
  for (const f of delta.features.removed) {
    const retire = (f.acceptance ?? []).map((e) => e.id).filter((id) => typeof id === 'string');
    const tail = [
      retire.length ? `Remove the tests tagged ${tags(retire)}, and only those.` : '',
      `Add a test that the menu no longer shows ${f.title} and that its old address says it is no longer available.`,
    ].filter(Boolean).join(' ');
    const lead = `Take ${f.title} out of the pages, the menu and the routes. Keep its tables and stored files, and do not write a database change that drops or empties anything: deleting old data is the client's decision.`;
    units.push({
      id: `remove-${f.id}`, title: `Remove ${f.title}`, covers: [], acceptance: [], kind: 'fix', dependsOn: [],
      instructions: fit('', lead, tail), change: 'removed', retire,
    });
  }
  const wide = briefWideSentences(delta);
  if (wide.length) {
    units.push({
      id: 'brief-wide-changes', title: 'Brief-wide changes', covers: [], acceptance: [], kind: 'fix', dependsOn: [],
      instructions: fit('', wide.join(' '), 'For each role change, make sure the role-crossing tests cover it.'),
      change: 'brief-wide', retire: [],
    });
  }
  return units;
}
