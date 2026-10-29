// src/secrets.js
// Two layers keep credentials out of prompts, transcripts, state and hook payloads:
//   1. scrub at the source: child processes never inherit the keys listed in SCRUB_ENV
//      unless a caller explicitly needs one (the local model's own provider key);
//   2. redact at every exit: any value of a secret-looking env var (or one listed in REDACT_ENV)
//      is replaced before it is logged, saved, sent to an agent or handed to a hook.
// Only the explicit SCRUB_ENV list is removed from child envs: blanket-scrubbing
// every *KEY* name would break ANTHROPIC_API_KEY / OPENAI_API_KEY auth for the frontier CLIs.

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const MIN_SECRET_LENGTH = 8;
export const REDACTED = '[redacted]';

export const SCRUB_ENV = ['LOCALAI_API_KEY'];
// The frontier CLIs authenticate with these: never scrub them, whatever a config says.
const FRONTIER_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

// A local provider configured with a different env key is scrubbed from every other child too.
export function addScrubEnv(name) {
  if (typeof name === 'string' && name && !FRONTIER_KEYS.has(name) && !SCRUB_ENV.includes(name)) SCRUB_ENV.push(name);
}

export function childEnv({ allow = [], env = process.env } = {}) {
  const out = { ...env };
  for (const k of SCRUB_ENV) if (!allow.includes(k)) delete out[k];
  return out;
}

// Git's env-borne config: GIT_CONFIG_COUNT with numbered GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs, and
// GIT_CONFIG_PARAMETERS (what `git -c` passes on). SECRET_NAME catches only the KEY_<n> names, which left a
// dangling COUNT that makes every git call fail; and the values can carry credentials (http.extraHeader).
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/;

// For children that need no credentials at all (the test command, N2): also drops
// every secret-looking name and all of git's env-borne config, as one group.
// The frontier CLIs keep using childEnv().
export function strictChildEnv({ env = process.env } = {}) {
  const out = childEnv({ env });
  for (const k of Object.keys(out)) if (SECRET_NAME.test(k) || GIT_CONFIG_ENV.test(k)) delete out[k];
  return out;
}

// Redacted from every exit but NOT scrubbed from children: the app's tests need the test database's address,
// which carries its password. Its name does not look secret, so it is listed here.
export const REDACT_ENV = ['TEST_DATABASE_URL'];

// A URL's password on its own, as written and decoded, so output that prints only the password is caught too.
function urlPasswords(v) {
  let pw;
  try { pw = new URL(v).password; } catch { return []; }
  if (!pw) return [];
  let decoded = pw;
  try { decoded = decodeURIComponent(pw); } catch { /* keep it as written */ }
  return [pw, decoded];
}

// Values learned at run time (a typed bot token, a generated password) that no env var carries.
// Same length floor as env values: shorter ones would redact ordinary words.
const remembered = new Set();
export function rememberSecret(value) {
  if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) remembered.add(value);
}
export function forgetRememberedSecrets() { remembered.clear(); }

export function secretValues(env = process.env) {
  const values = new Set();
  const add = (v) => { if (typeof v === 'string' && v.length >= MIN_SECRET_LENGTH) values.add(v); };
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_NAME.test(k) || SCRUB_ENV.includes(k)) add(v);
    else if (REDACT_ENV.includes(k)) { add(v); if (typeof v === 'string') urlPasswords(v).forEach(add); }
  }
  for (const v of remembered) values.add(v);
  return [...values].sort((a, b) => b.length - a.length);
}

const isPlainObject = (x) => {
  if (!x || typeof x !== 'object') return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

// Deep-walks strings, arrays and plain objects; anything else is returned as is.
export function redact(x, secrets = secretValues()) {
  if (!secrets.length) return x;
  const walk = (v, depth) => {
    if (typeof v === 'string') {
      let s = v;
      for (const secret of secrets) if (s.includes(secret)) s = s.replaceAll(secret, REDACTED);
      return s;
    }
    if (depth > 50) return v;
    if (Array.isArray(v)) return v.map((e) => walk(e, depth + 1));
    if (isPlainObject(v)) {
      const out = {};
      for (const [k, e] of Object.entries(v)) out[k] = walk(e, depth + 1);
      return out;
    }
    return v;
  };
  return walk(x, 0);
}
