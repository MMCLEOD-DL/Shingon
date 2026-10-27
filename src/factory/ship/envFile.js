// Writing settings into a client box's .env, and reading the backup password out of it once.
// The .env itself is made on the box by the foundation's own `ops init --out`; Conductor only fills in the
// lines its checklist asks for, and only through standard input (never argv, files or logs).
// Foundation v0.1.0 has no command for this; v0.2.0's `ops set-env` replaces setEnvCommand later (Contract 7 §7.9).
import { remoteRun, sshProblem } from './remote.js';
import { assertSafe, shQuote } from '../remote.js';
import { redact, rememberSecret } from '../../secrets.js';
import { terminalText } from '../brief.js';

// Conductor may write only these. DB_PASSWORD, HEALTH_TOKEN and BACKUP_PASSWORD are made by `ops init` on the box.
export const SETTABLE = Object.freeze(['APP_TAG', 'APP_IMAGE', 'OPS_IMAGE', 'IMAGE_PULL_POLICY', 'COMPOSE_PROFILES', 'SMTP_URL',
  'EMAIL_FROM', 'BACKUP_REPOSITORY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION', 'B2_ACCOUNT_ID',
  'B2_ACCOUNT_KEY', 'RESTIC_REST_USERNAME', 'RESTIC_REST_PASSWORD', 'MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN', 'MATRIX_ROOM_ID',
  'ALERT_WEBHOOK_URL', 'HEARTBEAT_URL', 'TUNNEL_TOKEN', 'TUNNEL_ENABLED']);

// Mirrors dotenvValue in the foundation's ops/src/init.ts (v0.1.0), so Compose reads the value back as typed.
export function dotenvLine(key, value) {
  if (!SETTABLE.includes(key)) throw new Error(`Conductor may not set ${key} on a box.`);
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error(`The value for ${key} has a line break in it. Paste it again on one line.`);
  if (/^[A-Za-z0-9_@%+=:,./ -]*$/.test(v) && v === v.trim()) return `${key}=${v}`;
  return `${key}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$')}"`;
}

// The remote command holds no value: the KEY=value lines arrive on its standard input. It replaces the first
// `KEY=…` or `# KEY=…` line for each key (the layout `ops init` writes), appends keys it did not find, and keeps mode 600.
export function setEnvCommand(bundleDir) {
  return `set -eu
cd ${shQuote(assertSafe('path', bundleDir))}
[ -f .env ] || { echo "There is no .env in this folder." >&2; exit 3; }
umask 077
tmp=$(mktemp .env.conductor.XXXXXX)
trap 'rm -f "$tmp"' EXIT
awk 'NR == FNR { k = substr($0, 1, index($0, "=") - 1); v[k] = $0; order[++n] = k; next }
{ key = $0; sub(/^# /, "", key); key = substr(key, 1, index(key, "=") - 1)
  if (key ~ /^[A-Z0-9_]+$/ && (key in v) && !(key in done)) { print v[key]; done[key] = 1; next }
  print }
END { for (i = 1; i <= n; i++) if (!(order[i] in done)) print v[order[i]] }' - .env > "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
trap - EXIT
`;
}

const firstLine = (s) => String(redact(terminalText(String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '')))
  .slice(0, 160).replace(/[.\s]+$/, '');

export async function setEnv(t, dir, settings, { env = process.env, timeoutMs = 120000 } = {}) {
  if (!settings.length) return { ok: true }; // an empty stdin would make awk read .env as its first file
  const input = settings.map((s) => dotenvLine(s.key, s.value)).join('\n') + '\n';
  const r = await remoteRun(t, setEnvCommand(dir), { input, env, timeoutMs });
  if (r.code === 0) return { ok: true };
  if (r.unreachable) return { ok: false, problem: sshProblem(t, r) };
  return { ok: false, problem: `The settings could not be written into .env on ${t.label} (${firstLine(r.stderr) || `code ${r.code}`}).` };
}

// Undoes dotenvValue's quoting, in case `ops init` quoted the value.
function unquote(v) {
  if (v.length < 2 || !v.startsWith('"') || !v.endsWith('"')) return v;
  return v.slice(1, -1).replace(/\$\$|\\(["\\])/g, (m, c) => (m === '$$' ? '$' : c));
}

// The value is remembered as a secret before anything else sees it. Empty → null. Throws (plain English) if the box
// could not be asked, so the caller never mistakes "could not read" for "not there".
export async function readBackupPassword(t, dir, { env = process.env } = {}) {
  const r = await remoteRun(t, `sed -n 's/^BACKUP_PASSWORD=//p' ${shQuote(`${assertSafe('path', dir)}/.env`)}`, { env, timeoutMs: 60000 });
  const raw = String(r.stdout ?? '').split('\n')[0].trim();
  rememberSecret(raw);
  if (r.code !== 0) throw new Error(r.unreachable ? sshProblem(t, r) : `The new settings on ${t.label} could not be read (code ${r.code}).`);
  const value = unquote(raw);
  rememberSecret(value);
  return value === '' ? null : value;
}
