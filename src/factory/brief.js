// The project brief (Contract 2): defensive normalisation of model replies and the plain-English
// validator every brief passes through. Content keys come from the model via normalizeBrief; the
// meta keys (slug, version, approvedAt, example ids...) are stamped by Conductor only.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { exampleProblems, EXAMPLE_ID_RE, testTag } from './acceptance.js';
import { writeFileAtomic, writeJsonAtomic, createFileExclusive } from './fsAtomic.js';
import { OUTBOUND_SERVICES, outboundProblems } from './outbound.js';
import { validateSlug } from './projects.js';
import { secretValues } from '../secrets.js';

export const BRIEF_SCHEMA = 1;
export const ROLE_MAPS = ['admin', 'manager', 'member'];
export const MODULES = ['ocr', 'pdf-export', 'xlsx-export', 'scheduled-jobs'];
export const OUTPUT_FORMATS = ['screen', 'pdf', 'xlsx', 'csv', 'email'];
export const HOSTING = ['client-box', 'operator-server'];
export const RESIDENCY = ['uk', 'uk-eu', 'any'];
export const BACKUP_KINDS = ['client-owned', 'operator-run', 'cloud-bucket'];
export const LIMITS = Object.freeze({ short: 200, text: 2000, list: 50, features: 60, examples: 20, questions: 12 });

const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩‎‏]/g;

export function cleanText(value, max) {
  if (typeof value !== 'string') return undefined;
  const s = value.replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '').replace(CONTROL_RE, '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---- normalisation ----

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const short = (v) => cleanText(v, LIMITS.short);
const long = (v) => cleanText(v, LIMITS.text);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const enumOrNull = (v) => (v === null ? null : short(v));

// Build a fresh object holding only the keys whose cleaned value is defined.
function build(src, spec) {
  const out = {};
  for (const [key, clean] of Object.entries(spec)) {
    const v = clean(src[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

const objects = (max, spec) => (v) => (Array.isArray(v)
  ? v.filter(isObj).slice(0, max).map((e) => build(e, spec))
  : undefined);
const strings = (clean, max = LIMITS.list) => (v) => (Array.isArray(v)
  ? v.map(clean).filter((s) => s !== undefined).slice(0, max)
  : undefined);
const nested = (spec) => (v) => (isObj(v) ? build(v, spec) : undefined);
const nullableNested = (spec) => (v) => (v === null ? null : nested(spec)(v));
const daysOrNull = (v) => (v === null || (typeof v === 'number' && Number.isFinite(v)) ? v : undefined);

const EXAMPLE_SPEC = { given: long, when: long, then: long };
const FEATURE_SPEC = {
  id: short, title: short, story: long, roles: strings(short), data: strings(short),
  acceptance: objects(LIMITS.examples, EXAMPLE_SPEC),
};
const POLICY_SPEC = {
  hosting: enumOrNull, outbound: strings(short), residency: enumOrNull,
  retention: nullableNested({ text: long, days: daysOrNull }),
  backupDestination: nullableNested({ kind: enumOrNull, detail: long }),
  operatorAccess: bool,
};
const BRIEF_SPEC = {
  client: short, purpose: long, kind: short,
  roles: objects(LIMITS.list, { name: short, whatTheyDo: long, sees: long, mapsTo: short }),
  records: objects(LIMITS.list, { name: short, description: long, holdsFiles: bool, personalData: bool }),
  features: objects(LIMITS.features, FEATURE_SPEC),
  outputs: objects(LIMITS.list, { name: short, format: short, roles: strings(short), description: long }),
  integrations: objects(LIMITS.list, { name: short, purpose: long, dataSent: long, service: short }),
  modules: strings(short),
  policy: nested(POLICY_SPEC),
  assumptions: strings(long),
  openQuestions: objects(LIMITS.questions, { id: short, question: long, why: long }),
};

export function normalizeBrief(raw) {
  const src = isObj(raw) ? raw : {};
  return { schema: BRIEF_SCHEMA, ...build(src, BRIEF_SPEC) };
}

// ---- validation ----

const STAGES = ['draft', 'ready', 'approved'];
const FEATURE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CREDENTIAL_RES = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(password|passwd|secret|api[ _-]?key|token)\b\s*[:=]\s*\S{6,}/i,
];

const filled = (v) => typeof v === 'string' && v.trim() !== '';
const arr = (v) => (Array.isArray(v) ? v : []);
const objs = (v) => arr(v).filter(isObj);
const list = (items) => items.join(', ');
const orList = (items) => `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
const isIso = (x) => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;

function credentialProblems(brief) {
  const found = [];
  const secrets = secretValues();
  const seen = new Set();
  const walk = (v, path) => {
    if (found.length >= 3) return;
    if (typeof v === 'string') {
      if (CREDENTIAL_RES.some((re) => re.test(v)) || secrets.some((s) => v.includes(s))) {
        found.push(`The brief seems to contain a password or key (at ${path.join(' → ')}). Briefs must never hold credentials: remove it.`);
      }
    } else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i + 1]));
      else for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
    }
  };
  walk(brief, []);
  return found;
}

function enumProblem(label, allowed, hint, value) {
  if (typeof value === 'string' && allowed.includes(value)) return null;
  const choices = hint ?? orList(allowed);
  return value === null || value === undefined || value === ''
    ? `${label} must be ${choices}; the brief does not say.`
    : `${label} must be ${choices}, not "${value}".`;
}

function policyProblems(policy, lenient) {
  const problems = [];
  const unset = (v) => v === null || v === undefined;
  const push = (p) => { if (p) problems.push(p); };
  if (!(lenient && unset(policy.hosting))) {
    push(enumProblem('Hosting', HOSTING, "client-box (the client's own computer) or operator-server (a server you run)", policy.hosting));
  }
  if (!(lenient && unset(policy.residency))) push(enumProblem('Data residency', RESIDENCY, null, policy.residency));
  problems.push(...outboundProblems(policy.outbound));

  const r = policy.retention;
  if (!(lenient && unset(r))) {
    if (!isObj(r) || (!filled(r.text) && unset(r.days))) {
      problems.push('The data policy does not say how long records are kept (retention).');
    } else if (!unset(r.days) && !(Number.isInteger(r.days) && r.days >= 1 && r.days <= 36500)) {
      problems.push('The data policy\'s retention days must be a whole number from 1 to 36500, or null when not known.');
    }
  }
  const b = policy.backupDestination;
  if (!(lenient && unset(b))) {
    if (!isObj(b)) problems.push('The data policy does not say where backups go (backupDestination).');
    else {
      push(enumProblem('The backup destination', BACKUP_KINDS, null, b.kind));
      if (!filled(b.detail)) problems.push('The backup destination does not say where exactly the backups go (detail).');
    }
  }
  if (policy.operatorAccess === false || (!lenient && policy.operatorAccess !== true)) {
    problems.push('The client has not accepted your remote access for support (operatorAccess must be true). The factory cannot take on a job without it.');
  }
  return problems;
}

export function validateBrief(obj, { stage = 'ready' } = {}) {
  if (!STAGES.includes(stage)) throw new Error('validateBrief: stage must be draft, ready or approved');
  if (!isObj(obj)) return { ok: false, problems: ['The brief is not a JSON object.'] };
  const problems = [];
  const b = obj;
  const questions = objs(b.openQuestions);
  const lenient = stage === 'draft' && arr(b.openQuestions).length > 0;

  // Approval first (Ruling P1): Task 4 expects the list to start with it.
  if (stage === 'approved') {
    if (!isIso(b.approvedAt) || !filled(b.approvedBy)) {
      problems.push('The brief has not been approved by the operator (approvedAt / approvedBy are missing or invalid).');
    }
    const slugProblem = validateSlug(b.slug);
    if (slugProblem) problems.push(`The brief has no valid slug. ${slugProblem}`);
    if (!Number.isInteger(b.version) || b.version < 1) problems.push('The brief has no valid version number.');
  }

  // 1. identity and kind
  if (b.schema !== BRIEF_SCHEMA) {
    problems.push(`The brief is in a format this Conductor does not know (schema ${b.schema}; expected ${BRIEF_SCHEMA}).`);
  }
  if (!filled(b.kind)) problems.push('The brief does not say what kind of software it is.');
  else if (b.kind !== 'web-app') problems.push(`This brief is for "${b.kind}", but the factory can only build web apps for now.`);
  if (!filled(b.client)) problems.push('The brief does not say who the client is.');
  if (!filled(b.purpose) || b.purpose.trim().length < 40) {
    problems.push('The purpose is too short: one paragraph saying what the app is for (at least 40 characters).');
  }

  // 2. roles
  const roles = objs(b.roles);
  if (roles.length === 0) problems.push('The brief has no roles: say who will use the app.');
  const roleNames = new Set();
  roles.forEach((r, i) => {
    const label = filled(r.name) ? `Role "${r.name}"` : `Role ${i + 1}`;
    if (!filled(r.name)) problems.push(`Role ${i + 1} has no name.`);
    else if (roleNames.has(r.name)) problems.push(`Two roles are called "${r.name}".`);
    else roleNames.add(r.name);
    if (!filled(r.whatTheyDo)) problems.push(`${label} does not say what they do.`);
    if (!filled(r.sees)) problems.push(`${label} does not say what it may see.`);
    const m = enumProblem(`${label}: "mapsTo"`, ROLE_MAPS, "admin, manager or member (the foundation's fixed roles)", r.mapsTo);
    if (m) problems.push(m);
  });
  if (roles.length > 0 && !roles.some((r) => r.mapsTo === 'admin')) {
    problems.push('No role maps to admin: someone must be able to manage users.');
  }

  // 3. records
  const records = objs(b.records);
  if (records.length === 0) problems.push('The brief lists no records: say what the app stores (for example claims, receipts, customers).');
  const recordNames = new Set();
  records.forEach((r, i) => {
    if (!filled(r.name)) problems.push(`Record ${i + 1} has no name.`);
    else if (recordNames.has(r.name)) problems.push(`Two records are called "${r.name}".`);
    else recordNames.add(r.name);
  });

  // 4. features
  const features = objs(b.features);
  if (features.length === 0) problems.push('The brief has no features.');
  const featureIds = new Set();
  features.forEach((f, i) => {
    const id = filled(f.id) ? f.id : null;
    const label = `Feature "${id ?? i + 1}"`;
    if (id === null) problems.push(`Feature ${i + 1} has no id.`);
    else if (!FEATURE_ID_RE.test(id)) problems.push(`${label}: its id must be lower-case words joined by hyphens, like upload-receipt.`);
    else if (featureIds.has(id)) problems.push(`Two features have the id "${id}".`);
    else featureIds.add(id);
    if (!filled(f.title)) problems.push(`${label} has no title.`);
    if (!filled(f.story)) problems.push(`${label} has no story: say in a sentence or two what it does.`);
    const fRoles = arr(f.roles);
    if (fRoles.length === 0) problems.push(`${label} is not used by any role.`);
    for (const r of fRoles) if (!roleNames.has(r)) problems.push(`${label} is used by "${r}", which is not one of the roles.`);
    for (const d of arr(f.data)) if (!recordNames.has(d)) problems.push(`${label} uses "${d}", which is not one of the records.`);
    const examples = arr(f.acceptance);
    if (examples.length === 0 && !lenient) {
      problems.push(`${label} has no worked examples: add at least one given / when / then with real figures.`);
    }
    examples.forEach((ex, k) => problems.push(...exampleProblems(ex, `${label}, example ${k + 1}`)));
  });

  // 5. outputs and modules
  const modules = arr(b.modules);
  for (const m of modules) {
    if (!MODULES.includes(m)) problems.push(`"${m}" is not an optional module the foundation has (${list(MODULES)}).`);
  }
  objs(b.outputs).forEach((o, i) => {
    const label = filled(o.name) ? `Output "${o.name}"` : `Output ${i + 1}`;
    if (!filled(o.name)) problems.push(`Output ${i + 1} has no name.`);
    const fmt = enumProblem(`${label}: the format`, OUTPUT_FORMATS, null, o.format);
    if (fmt) problems.push(fmt);
    if (o.format === 'pdf' && !modules.includes('pdf-export')) problems.push(`${label} is a PDF, so the modules must include pdf-export.`);
    if (o.format === 'xlsx' && !modules.includes('xlsx-export')) problems.push(`${label} is a spreadsheet, so the modules must include xlsx-export.`);
    for (const r of arr(o.roles)) if (!roleNames.has(r)) problems.push(`${label} is for "${r}", which is not one of the roles.`);
  });

  // 6. integrations
  const policy = isObj(b.policy) ? b.policy : null;
  const allowed = policy && Array.isArray(policy.outbound) ? policy.outbound : [];
  const serviceIds = Object.keys(OUTBOUND_SERVICES);
  objs(b.integrations).forEach((it, i) => {
    const label = `Integration "${filled(it.name) ? it.name : i + 1}"`;
    if (typeof it.service !== 'string' || !Object.hasOwn(OUTBOUND_SERVICES, it.service)) {
      const known = `one of the outside services Conductor knows (${list(serviceIds)})`;
      problems.push(filled(it.service)
        ? `${label}: "service" must be ${known}, not "${it.service}".`
        : `${label}: "service" must be ${known}; the brief does not say.`);
    } else if (!allowed.includes(it.service)) {
      problems.push(`${label} sends data to ${OUTBOUND_SERVICES[it.service].label}, but the data policy does not allow it: add "${it.service}" to the policy's outside services, or drop the integration.`);
    }
  });

  // 7. policy
  if (policy) problems.push(...policyProblems(policy, lenient));
  else if (!lenient) problems.push('The brief has no data policy: hosting, where data may go, residency, retention, backups and operator access.');

  // 8. credentials
  problems.push(...credentialProblems(b));

  // 9. assumptions and open questions
  arr(b.openQuestions).forEach((q, i) => {
    if (!isObj(q) || !filled(q.id) || !filled(q.question) || !filled(q.why)) {
      problems.push(`Open question ${i + 1} is missing its question or why it matters.`);
    }
  });
  if (stage !== 'draft' && questions.length > 0) {
    const n = questions.length;
    problems.push(n === 1
      ? "There is still 1 open question; the brief can't be approved until it is answered."
      : `There are still ${n} open questions; the brief can't be approved until they are answered.`);
  }

  // 10. approved: example ids
  if (stage === 'approved') {
    const seq = b.exampleSeq;
    if (!isObj(seq) || Object.values(seq).some((n) => !Number.isInteger(n) || n < 1)) {
      problems.push('The brief has no valid example counter (exampleSeq).');
    }
    const seenIds = new Set();
    features.forEach((f) => {
      arr(f.acceptance).forEach((ex, k) => {
        const id = isObj(ex) ? ex.id : undefined;
        const m = typeof id === 'string' ? EXAMPLE_ID_RE.exec(id) : null;
        const limit = isObj(seq) ? seq[f.id] : undefined;
        if (!m || m[1] !== f.id || !Number.isInteger(limit) || Number(m[2]) > limit) {
          problems.push(`Feature "${f.id}", example ${k + 1} has no valid id (Conductor numbers examples when the brief is approved).`);
        } else if (seenIds.has(id)) problems.push(`Two worked examples have the id "${id}".`);
        else seenIds.add(id);
      });
    });
  }

  return { ok: problems.length === 0, problems };
}

// ---- rendering ----

export function ukDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an unknown date';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const NOT_DECIDED = 'not decided yet';
const HOSTING_WORDS = { 'client-box': "on the client's own computer (a box on their network)", 'operator-server': 'on a server you run for the client' };
const RESIDENCY_WORDS = { uk: 'UK only', 'uk-eu': 'UK and EU', any: 'anywhere' };
const BACKUP_WORDS = { 'client-owned': 'client-owned storage', 'operator-run': 'storage you run', 'cloud-bucket': 'a cloud storage bucket' };
const FORMAT_WORDS = { screen: 'on screen', pdf: 'PDF', xlsx: 'spreadsheet', csv: 'CSV file', email: 'email' };
const MODULE_WORDS = { ocr: 'Reading receipts automatically (OCR)', 'pdf-export': 'PDF reports', 'xlsx-export': 'Spreadsheet exports', 'scheduled-jobs': 'Scheduled jobs' };

const oneLine = (v) => String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
const cell = (v) => oneLine(v).replace(/\|/g, '\\|');
const word = (map, v) => (typeof v === 'string' && v !== '' ? (Object.hasOwn(map, v) ? map[v] : oneLine(v)) : NOT_DECIDED);
const sentence = (s) => { const t = oneLine(s); return /[.!?]$/.test(t) ? t : `${t}.`; };

function outboundWords(outbound) {
  if (!Array.isArray(outbound)) return NOT_DECIDED;
  if (outbound.length === 0) return 'nowhere outside the app';
  return `only to ${outbound.map((id) => (Object.hasOwn(OUTBOUND_SERVICES, id)
    ? `${OUTBOUND_SERVICES[id].label} (carries ${OUTBOUND_SERVICES[id].carries})`
    : `${oneLine(id)} (not a service Conductor knows)`)).join('; ')}`;
}

function policyLines(policy) {
  const p = isObj(policy) ? policy : {};
  const r = p.retention;
  let retention = NOT_DECIDED;
  if (isObj(r)) {
    const text = oneLine(r.text);
    const days = typeof r.days === 'number' ? `${r.days} days` : '';
    retention = text ? (days ? `${text} (${days})` : text) : (days || NOT_DECIDED);
  }
  const b = p.backupDestination;
  const backups = isObj(b) && typeof b.kind === 'string' && b.kind !== ''
    ? `${word(BACKUP_WORDS, b.kind)}${oneLine(b.detail) ? `: ${oneLine(b.detail)}` : ''}`
    : NOT_DECIDED;
  return [
    `- **Hosting:** ${word(HOSTING_WORDS, p.hosting)}`,
    `- **Where data may go:** ${outboundWords(p.outbound)}`,
    `- **Data residency:** ${word(RESIDENCY_WORDS, p.residency)}`,
    `- **Retention:** ${retention}`,
    `- **Backups:** ${backups}`,
    `- **Operator access:** ${p.operatorAccess === true ? 'the client accepts that you can reach the app remotely to support it' : NOT_DECIDED}`,
  ];
}

function featureLines(f, n) {
  const lines = [`### ${n}. ${oneLine(f.title)} (\`${oneLine(f.id)}\`)`, '', oneLine(f.story), ''];
  const roles = arr(f.roles).map(oneLine);
  const data = arr(f.data).map(oneLine);
  if (roles.length) lines.push(`- Used by: ${roles.join(', ')}`);
  if (data.length) lines.push(`- Uses: ${data.join(', ')}`);
  const examples = objs(f.acceptance);
  if (examples.length) {
    lines.push('- Worked examples:');
    for (const ex of examples) {
      const tag = typeof ex.id === 'string' && EXAMPLE_ID_RE.test(ex.id) ? `${testTag(ex.id)} ` : '';
      lines.push(`  - ${tag}Given ${oneLine(ex.given)}, when ${oneLine(ex.when)}, then ${sentence(ex.then)}`);
    }
  }
  return lines.join('\n');
}

export function renderBrief(brief) {
  const b = isObj(brief) ? brief : {};
  const v = Number.isInteger(b.version) ? b.version : null;
  const approved = isIso(b.approvedAt) && filled(b.approvedBy);
  const status = approved
    ? `Version ${v} · approved by ${oneLine(b.approvedBy)} on ${ukDate(b.approvedAt)}`
    : `Draft: not yet approved${v !== null ? ` (will become version ${v})` : ''}`;
  const sections = [`# Brief: ${oneLine(b.client)}`, status, `## What the app is for\n\n${b.purpose ?? ''}`];
  sections.push(['## Data policy', '', ...policyLines(b.policy)].join('\n'));

  sections.push(['## Who uses it', '', '| Role | What they do | What they can see | Foundation role |', '|---|---|---|---|',
    ...objs(b.roles).map((r) => `| ${cell(r.name)} | ${cell(r.whatTheyDo)} | ${cell(r.sees)} | ${cell(r.mapsTo)} |`)].join('\n'));

  sections.push(['## What it stores', '', ...objs(b.records).map((r) => {
    const flags = [r.holdsFiles === true && 'holds files', r.personalData === true && 'personal data'].filter(Boolean);
    return `- **${oneLine(r.name)}:** ${oneLine(r.description)}${flags.length ? ` (${flags.join('; ')})` : ''}`;
  })].join('\n'));

  sections.push(['## Features', '', objs(b.features).map((f, i) => featureLines(f, i + 1)).join('\n\n')].join('\n'));

  sections.push(['## Reports, exports and emails', '', ...objs(b.outputs).map((o) => {
    const roles = arr(o.roles).map(oneLine);
    return `- **${oneLine(o.name)}** (${word(FORMAT_WORDS, o.format)}${roles.length ? `, for ${roles.join(', ')}` : ''}): ${oneLine(o.description)}`;
  })].join('\n'));

  const integrations = objs(b.integrations);
  sections.push(['## Outside systems', '', ...(integrations.length ? integrations.map((it) => {
    const label = Object.hasOwn(OUTBOUND_SERVICES, it.service) ? OUTBOUND_SERVICES[it.service].label : oneLine(it.service);
    return `- **${oneLine(it.name)}:** ${oneLine(it.purpose)} (sends: ${oneLine(it.dataSent)} to ${label})`;
  }) : ['None.'])].join('\n'));

  const modules = arr(b.modules);
  sections.push(['## Optional modules', '', ...(modules.length ? modules.map((m) => `- ${word(MODULE_WORDS, m)}`) : ['None.'])].join('\n'));

  const assumptions = arr(b.assumptions);
  if (assumptions.length) sections.push(['## Assumptions to check', '', ...assumptions.map((a) => `- ${oneLine(a)}`)].join('\n'));

  const questions = objs(b.openQuestions);
  if (questions.length) {
    sections.push(['## Open questions', '', ...questions.map((q, i) => `${i + 1}. ${oneLine(q.question)} (Why it matters: ${oneLine(q.why)})`)].join('\n'));
  }
  if (v !== null) sections.push(`---\n\nThis file is a copy for reading. Conductor builds from brief-v${v}.json.`);
  return `${sections.join('\n\n')}\n`;
}

// ---- versioned save and load ----

export function briefPaths(projectDir) {
  const dir = path.join(projectDir, 'brief');
  return {
    dir,
    current: path.join(dir, 'current.json'),
    session: path.join(dir, 'session.json'),
    draftMd: path.join(dir, 'draft.md'),
    logs: path.join(dir, 'logs'),
    json: (v) => path.join(dir, `brief-v${v}.json`),
    md: (v) => path.join(dir, `brief-v${v}.md`),
  };
}

const BRIEF_FILE_RE = /^brief-v([1-9]\d{0,5})\.json$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const NO_BRIEF = 'There is no approved brief for this project yet. Make one with: conductor brief <slug> --notes <file>';
const DAMAGED = 'The brief pointer (current.json) is damaged. Approve the brief again with conductor brief <slug> --revise --notes <file>.';

export function nextVersion(projectDir) {
  const { dir } = briefPaths(projectDir);
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = BRIEF_FILE_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function saveApprovedBrief(projectDir, brief) {
  const check = validateBrief(brief, { stage: 'approved' });
  if (!check.ok) throw new Error(`This brief cannot be saved as approved: ${check.problems.slice(0, 3).join(' ')}`);
  const v = brief.version;
  const p = briefPaths(projectDir);
  mkdirSync(p.dir, { recursive: true });
  const text = `${JSON.stringify(brief, null, 2)}\n`;
  try {
    createFileExclusive(p.json(v), text);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`Brief version ${v} already exists; Conductor never overwrites an approved brief.`);
    throw err;
  }
  writeFileAtomic(p.md(v), renderBrief(brief));
  writeJsonAtomic(p.current, {
    schema: 1, version: v, json: `brief-v${v}.json`, md: `brief-v${v}.md`,
    sha256: sha256(Buffer.from(text)), approvedAt: brief.approvedAt, approvedBy: brief.approvedBy,
  });
  return { version: v, jsonPath: p.json(v), mdPath: p.md(v) };
}

function readPointer(projectDir) {
  const { current } = briefPaths(projectDir);
  if (!existsSync(current)) throw new Error(NO_BRIEF);
  let ptr;
  try { ptr = JSON.parse(readFileSync(current, 'utf8')); } catch { throw new Error(DAMAGED); }
  if (!isObj(ptr) || ptr.schema !== 1 || typeof ptr.json !== 'string' || !BRIEF_FILE_RE.test(ptr.json)
    || typeof ptr.sha256 !== 'string' || !SHA_RE.test(ptr.sha256)) throw new Error(DAMAGED);
  return ptr;
}

export function loadBrief(projectDir) {
  const ptr = readPointer(projectDir);
  let buf;
  try { buf = readFileSync(path.join(briefPaths(projectDir).dir, ptr.json)); } catch {
    throw new Error(`${ptr.json} is missing. Approve a new version with conductor brief <slug> --revise --notes <file>.`);
  }
  if (sha256(buf) !== ptr.sha256) {
    throw new Error(`${ptr.json} has changed since it was approved (its fingerprint does not match). Conductor will not use it. Approve a new version with conductor brief <slug> --revise --notes <file>.`);
  }
  let brief;
  try { brief = JSON.parse(buf.toString('utf8')); } catch {
    throw new Error(`The approved brief (v${ptr.version}) is not valid: it is not readable JSON.`);
  }
  const check = validateBrief(brief, { stage: 'approved' });
  if (!check.ok) throw new Error(`The approved brief (v${ptr.version}) is not valid: ${check.problems.slice(0, 3).join(' ')}`);
  return brief;
}

export function currentBriefInfo(projectDir) {
  try {
    if (!existsSync(briefPaths(projectDir).current)) return null;
    const b = loadBrief(projectDir);
    return { version: b.version, approvedAt: b.approvedAt, approvedBy: b.approvedBy };
  } catch (e) {
    return { broken: e.message };
  }
}
