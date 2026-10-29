// Worked examples ("acceptance") in a brief: the concreteness check (spec §4.1) and the stable
// example ids Plans 8, 9 and 12 share (Contract 7 §7.4, Ruling 15).

export const EXAMPLE_RULES_TEXT = `Worked examples ("acceptance") are checked by Conductor before you see them again:
- Each example has "given", "when" and "then", each a full plain-English phrase.
- No placeholder words: TBD, TBC, TODO, etc, "and so on", "...", lorem ipsum.
- "then" must say exactly what happens: a figure, a name, a date or the exact words shown on screen.
- Never write outcomes such as "works correctly", "as expected" or "is handled".
- Good: given a member uploads a £12.40 receipt with £2.07 VAT dated 3 March 2026, category Travel; when the manager opens the March report; then the receipt appears under Travel with net £10.33 and VAT £2.07.
- If you need real figures or names from the client to write an example, ask the operator for them as an open question.`;

const PARTS = ['given', 'when', 'then'];
const PLACEHOLDER_RE = /\b(tbd|tbc|todo|etc|lorem ipsum|xxx|and so on)\b|\.\.\.|…|\?\?/i;
const VAGUE_RE = /\b(works?|working|behaves?) (correctly|properly|fine|as expected)\b|\bas expected\b|\b(correctly|properly|appropriately|successfully) (handled|processed|shown|displayed|saved)\b|\bis handled\b/i;
const MONTH_DAY_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const QUOTED_RE = /"[^"]{2,}"|“[^”]{2,}”|‘[^’]{2,}’|(?:^|\s)'[^']{2,}'/;

function hasCapitalisedName(text) {
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 1; i < words.length; i++) {
    if (/[.!?:]$/.test(words[i - 1])) continue;
    const w = words[i].replace(/^[^A-Za-z]+|[^A-Za-z'’]+$/g, '');
    if (/^[A-Z][A-Za-z'’]*$/.test(w) && (w.match(/[A-Za-z]/g) || []).length >= 2 && w !== 'I') return true;
  }
  return false;
}

function hasAnchor(text) {
  return /\d/.test(text) || QUOTED_RE.test(text) || MONTH_DAY_RE.test(text) || hasCapitalisedName(text);
}

export function exampleProblems(example, where) {
  const isObj = example && typeof example === 'object' && !Array.isArray(example);
  if (!isObj || PARTS.some((p) => typeof example[p] !== 'string' || !example[p].trim())) {
    return [`${where}: it needs "given", "when" and "then", each in plain words.`];
  }
  const problems = [];
  for (const part of PARTS) {
    const value = example[part].trim();
    if (value.length < 8) problems.push(`${where}: the "${part}" part is too short to check ("${value}").`);
    if (value.length > 600) problems.push(`${where}: the "${part}" part is too long (keep each part under 600 characters).`);
    const ph = value.match(PLACEHOLDER_RE);
    if (ph) problems.push(`${where}: the "${part}" part still has a placeholder ("${ph[0]}"). Replace it with the real detail.`);
  }
  const then = example.then.trim();
  const vague = then.match(VAGUE_RE);
  if (vague) problems.push(`${where}: "${vague[0].toLowerCase()}" cannot be checked by a test. Say what the person sees or what number comes out.`);
  if (!hasAnchor(then)) {
    problems.push(`${where}: the result ("then …") does not say exactly what should happen. Give a figure, a name, a date or the exact words shown, e.g. "then March's report shows Travel: £12.40".`);
  }
  return problems;
}

// ---- example ids ----

export const EXAMPLE_ID_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)#([1-9]\d{0,3})$/;

const exampleKey = (e) => PARTS.map((p) => String(e[p]).trim().replace(/\s+/g, ' ')).join('|');

export function assignExampleIds(brief, base = null) {
  const seq = { ...(base?.exampleSeq ?? {}) };
  for (const f of base?.features ?? []) {
    for (const e of f.acceptance ?? []) {
      const m = typeof e?.id === 'string' ? EXAMPLE_ID_RE.exec(e.id) : null;
      if (m && m[1] === f.id) seq[f.id] = Math.max(seq[f.id] ?? 0, Number(m[2]));
    }
  }
  const features = (brief.features ?? []).map((f) => {
    const pool = new Map();
    const baseFeature = (base?.features ?? []).find((b) => b.id === f.id);
    for (const e of baseFeature?.acceptance ?? []) {
      const m = typeof e?.id === 'string' ? EXAMPLE_ID_RE.exec(e.id) : null;
      if (m && m[1] === f.id) pool.set(exampleKey(e), e.id);
    }
    const used = new Set();
    const acceptance = (f.acceptance ?? []).map((e) => {
      const kept = pool.get(exampleKey(e));
      let id;
      if (kept && !used.has(kept)) id = kept;
      else {
        seq[f.id] = (seq[f.id] ?? 0) + 1;
        id = `${f.id}#${seq[f.id]}`;
      }
      used.add(id);
      return { id, given: e.given, when: e.when, then: e.then };
    });
    return { ...f, acceptance };
  });
  return { ...brief, features, exampleSeq: seq };
}

export function acceptanceIds(brief) {
  const out = [];
  for (const f of brief.features ?? []) {
    (f.acceptance ?? []).forEach((e, i) => {
      const m = typeof e?.id === 'string' ? EXAMPLE_ID_RE.exec(e.id) : null;
      if (!m || m[1] !== f.id) {
        throw new Error(`acceptanceIds: Feature "${f.id}", example ${i + 1} has no valid id; only an approved brief carries example ids.`);
      }
      out.push({ id: e.id, featureId: f.id, n: Number(m[2]), title: f.title, example: { given: e.given, when: e.when, then: e.then } });
    });
  }
  return out;
}

export function testTag(id) {
  if (typeof id !== 'string' || !EXAMPLE_ID_RE.test(id)) throw new Error(`testTag: "${id}" is not an example id`);
  return `[${id}]`;
}
