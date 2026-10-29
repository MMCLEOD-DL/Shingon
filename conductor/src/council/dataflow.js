// src/council/dataflow.js
// Legal for client apps: where can the app send data (outside connections against the data
// policy's services), and does it hold personal data without a retention rule. Matching is on
// OUTBOUND_SERVICES ids and hosts only, never free text (Contract 7 section 7.4).
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { makeFinding } from './findings.js';
import { TEST_FILE } from './correctness.js';
import { OUTBOUND_SERVICES } from '../factory/outbound.js';

export const OUTBOUND_PACKAGES = Object.freeze([
  { names: ['aws-sdk'], prefixes: ['@aws-sdk/'], service: 'Amazon Web Services', host: 'amazonaws.com' },
  { names: ['googleapis'], prefixes: ['@google-cloud/'], service: 'Google Cloud', host: 'googleapis.com' },
  { names: ['@azure/ai-form-recognizer', '@azure-rest/ai-document-intelligence'], prefixes: [], service: 'Azure Document Intelligence', host: 'cognitiveservices.azure.com' },
  { names: [], prefixes: ['@azure/'], service: 'Microsoft Azure', host: 'azure.com' },
  { names: ['openai'], prefixes: [], service: 'OpenAI', host: 'openai.com' },
  { names: ['@anthropic-ai/sdk'], prefixes: [], service: 'Anthropic', host: 'anthropic.com' },
  { names: ['stripe'], prefixes: [], service: 'Stripe', host: 'stripe.com' },
  { names: [], prefixes: ['@sendgrid/'], service: 'SendGrid', host: 'sendgrid.com' },
  { names: ['twilio'], prefixes: [], service: 'Twilio', host: 'twilio.com' },
  { names: [], prefixes: ['@sentry/'], service: 'Sentry', host: 'sentry.io' },
  { names: ['posthog-js', 'posthog-node'], prefixes: [], service: 'PostHog', host: 'posthog.com' },
  { names: ['mixpanel', 'mixpanel-browser'], prefixes: [], service: 'Mixpanel', host: 'mixpanel.com' },
  { names: ['tesseract.js'], prefixes: [], service: 'jsDelivr (tesseract.js downloads its language files from there unless told otherwise)', host: 'cdn.jsdelivr.net' },
]);

export const IGNORED_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.+\.(test|example|invalid|local|localhost)|example\.(com|org|net)|www\.w3\.org|json-schema\.org|schemas\..+)$/i;

const SKIP_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|package\.json)$|(^|\/)node_modules\/|\.(md|txt|rst|adoc)$|(^|\/)docs?\//i;
const DOC_FILE = /\.(md|txt|rst|adoc)$|(^|\/)docs?\//i;
const MAX_BYTES = 1024 * 1024;
const MAX_FINDINGS = 20;
const URL_RE = /\b(?:https?|wss?):\/\/(?:[^\s/@'"`<>]*@)?(\[[0-9a-f:]+\]|[a-z0-9][a-z0-9.-]*)/gi;

// Text files only (lstat so a symlink is never followed), up to 1 MB.
function readText(dir, f) {
  try {
    const p = path.join(dir, f);
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = readFileSync(p);
    return buf.includes(0) ? null : buf.toString('utf8');
  } catch { return null; }
}

export function outboundDestinations({ dir, files }) {
  const out = [];
  for (const f of files ?? []) {
    if (SKIP_FILE.test(f) || TEST_FILE.test(f)) continue;
    const text = readText(dir, f);
    if (text === null) continue;
    const seen = new Set();
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(URL_RE)) {
        const host = m[1].toLowerCase().replace(/\.+$/, '');
        if (IGNORED_HOST.test(host) || seen.has(host)) continue;
        if (!host.startsWith('[') && !host.includes('.')) continue; // a bare name is an internal service, not the internet
        seen.add(host);
        out.push({ host, service: null, file: f, line: i + 1, how: 'url' });
      }
    });
  }
  return out;
}

export function packageDestinations(packages) {
  const out = [];
  const seen = new Set();
  for (const p of packages ?? []) {
    if (p.dev) continue;
    const row = OUTBOUND_PACKAGES.find((r) => r.names.includes(p.name) || r.prefixes.some((x) => p.name.startsWith(x)));
    const pkg = `${p.name}@${p.version}`;
    if (!row || seen.has(pkg)) continue;
    seen.add(pkg);
    out.push({ host: row.host, service: row.service, file: 'package-lock.json', line: null, how: 'package', pkg });
  }
  return out;
}

export function hostMatches(pattern, host) {
  const p = String(pattern).toLowerCase();
  const h = String(host).toLowerCase();
  if (p.startsWith('*.')) { const d = p.slice(2); return h === d || h.endsWith(`.${d}`); }
  return p === h;
}

export function policyAllows(dest, outbound, services = OUTBOUND_SERVICES) {
  for (const id of Array.isArray(outbound) ? outbound : []) {
    if (typeof id !== 'string' || !Object.hasOwn(services, id)) continue;
    if ((services[id].hosts ?? []).some((h) => hostMatches(h, dest.host))) return id;
  }
  return null;
}

const place = (d) => (d.how === 'package' ? d.pkg : `${d.file}:${d.line}`);

export function dataFlowFindings(dests, policy, services = OUTBOUND_SERVICES) {
  const outbound = Array.isArray(policy?.outbound) ? policy.outbound : [];
  const known = outbound.filter((id) => typeof id === 'string' && Object.hasOwn(services, id));
  const allowedText = known.length ? known.map((id) => `${services[id].label} (${services[id].hosts.join(', ')})`).join('; ') : 'none';
  const blocked = new Map();
  const allowedLabels = [];
  for (const d of dests) {
    const id = policyAllows(d, outbound, services);
    if (id) { const l = services[id].label; if (!allowedLabels.includes(l)) allowedLabels.push(l); continue; }
    const key = d.how === 'package' ? `p|${d.service}` : `u|${d.host}`;
    if (!blocked.has(key)) blocked.set(key, { name: d.how === 'package' ? d.service : d.host, file: d.file, places: [] });
    blocked.get(key).places.push(place(d));
  }
  const out = [];
  for (const { name, file, places } of blocked.values()) {
    const shown = places.slice(0, 5).join(', ') + (places.length > 5 ? `, and ${places.length - 5} more` : '');
    out.push(makeFinding({ member: 'legal', tool: 'data-flow', grade: 'blocking', locked: false,
      title: `The app connects to ${name}, which the data policy does not allow`,
      detail: `Found at: ${shown}. Outside services the policy allows: ${allowedText}`,
      file }));
  }
  for (const id of outbound) {
    if (typeof id === 'string' && Object.hasOwn(services, id)) continue;
    out.push(makeFinding({ member: 'legal', tool: 'data-flow', grade: 'warning', title: `The data policy names an outside service Conductor does not know (${id})`,
      detail: 'It allows nothing, because the policy may only name services from Conductor\'s own list.' }));
  }
  const capped = out.slice(0, MAX_FINDINGS);
  if (allowedLabels.length) {
    capped.push(makeFinding({ member: 'legal', tool: 'data-flow', grade: 'note', title: `Outside services the app uses, all allowed by the data policy: ${allowedLabels.join(', ')}`,
      detail: 'These match the services the data policy allows, by host.' }));
  }
  return capped;
}

const PERSONAL = /(^|_)(name|first_name|last_name|full_name|email|phone|mobile|address|postcode|dob|birth|date_of_birth|ni_number|national_insurance|bank|sort_code|account_number|iban|salary|photo|signature|passport|licence|vehicle_reg)(_|$)/;
const SCHEMA_DIR = 'apps/server/src/db/schema/';
const NOT_COLUMNS = new Set(['pgTable', 'index', 'uniqueIndex', 'unique', 'primaryKey', 'foreignKey', 'check', 'pgEnum', 'pgSchema']);

export function personalDataFindings({ dir, files }) {
  const findings = [];
  const tables = [];
  for (const f of files ?? []) {
    if (!f.startsWith(SCHEMA_DIR) || TEST_FILE.test(f)) continue;
    const text = readText(dir, f);
    if (text === null) continue;
    const heads = [...text.matchAll(/pgTable\(\s*['"]([^'"]+)['"]/g)];
    heads.forEach((h, i) => {
      const body = text.slice(h.index + h[0].length, heads[i + 1]?.index ?? text.length);
      const cols = [];
      for (const m of body.matchAll(/(?<![.\w])(\w+)\(\s*['"](\w+)['"]/g)) {
        if (!NOT_COLUMNS.has(m[1]) && PERSONAL.test(m[2].toLowerCase()) && !cols.includes(m[2])) cols.push(m[2]);
      }
      if (!cols.length) return;
      tables.push(h[1]);
      findings.push(makeFinding({ member: 'legal', tool: 'data-policy', grade: 'note', file: f,
        title: `The ${h[1]} table holds personal data: ${cols.join(', ')}`,
        detail: 'Check that it is covered by the retention rule, that only the right roles can see it (the role-crossing tests), and that it is never written to the activity log.' }));
    });
  }
  return { findings, tables };
}

const RETENTION = /retention|RETENTION_DAYS|olderThan|older_than|purge|deleteExpired|delete_expired/i;

export function retentionFindings({ dir, files, policy, tables }) {
  if (!tables?.length) return [];
  const days = policy?.retention?.days;
  if (typeof days !== 'number') {
    return [makeFinding({ member: 'legal', tool: 'data-policy', grade: 'note', title: 'The data policy gives no number of days for keeping records, so retention could not be checked',
      detail: 'Personal data was found in the app, but the brief does not say how long it may be kept.' })];
  }
  const handled = (files ?? []).some((f) => {
    if (TEST_FILE.test(f) || DOC_FILE.test(f)) return false;
    if (RETENTION.test(f)) return true;
    const text = readText(dir, f);
    return text !== null && RETENTION.test(text);
  });
  if (handled) return [];
  return [makeFinding({ member: 'legal', tool: 'data-policy', grade: 'warning', title: `The data policy keeps records for ${days} days, but nothing the factory added deletes them after that`,
    detail: 'The app holds personal data (see the notes above) and no changed file looks like a retention job or rule.' })];
}
