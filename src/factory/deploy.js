// src/factory/deploy.js — bring the app up with demo data on a factory machine (previews; Plan 9's council deploy tests).
// Previews stay on the operator's own network (index Ruling 12): HTTP bound to the machine's LAN address, demo mode,
// mail caught by Mailpit, no ops service, no backups. Every value reaches the remote script through assertSafe + shQuote.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafe, shQuote, parseMarker } from './remote.js';
import { unreachable } from './ssh.js';
import { composeProjectOf } from './ids.js';
import { MachineError, runImages } from './machines/index.js';
import { git as gitFn } from '../workspace.js';
import { redact } from '../secrets.js';

export const MAILPIT_IMAGE = 'axllent/mailpit:v1.21.8'; // MIT; the version the foundation's own smoke uses

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ORIGIN_RE = /^http:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const COMMIT_RE = /^[0-9a-f]{4,40}$/;

function assertMatch(name, value, re) {
  if (typeof value !== 'string' || !re.test(value)) throw new Error(`unsafe ${name} for a remote command: ${JSON.stringify(value)}`);
  return value;
}

// The foundation smoke's setenv: replace KEY= (or its "# KEY=" form) in .env, else append it.
const SETENV_FN = `setenv() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 }
    !done && ($0 ~ "^" k "=" || $0 ~ "^# " k "=") { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$DIR/bundle/.env" > "$tmp"
  cat "$tmp" > "$DIR/bundle/.env" && rm -f "$tmp"
}
`;

// bindHost: the machine's IPv4 address, or null to find the box's own private (RFC1918) IPv4 on the box itself
// (Ruling Q32). Never 0.0.0.0: a preview is for the operator's network only.
// Every command that could read stdin gets </dev/null: the script itself arrives on stdin (ssh … bash -s).
export function demoUpScript({ root, project, slug, runId, client, origin, bindHost, port, version, commit }) {
  assertSafe('path', root); assertSafe('project', project); assertSafe('slug', slug); assertSafe('runId', runId);
  assertSafe('client', client); assertSafe('port', port);
  if (bindHost !== null && (typeof bindHost !== 'string' || !IPV4_RE.test(bindHost) || bindHost === '0.0.0.0')) {
    throw new Error(`unsafe bindHost for a remote command: ${JSON.stringify(bindHost)}`);
  }
  if (port + 1 > 65535) throw new Error(`unsafe port for a remote command: ${JSON.stringify(port)}`);
  assertMatch('origin', origin, ORIGIN_RE);
  assertMatch('version', version, VERSION_RE);
  assertMatch('commit', commit, COMMIT_RE);
  const [appImage, opsImage] = runImages(slug, runId).map((i) => assertSafe('image', i));
  const [appRepo, opsRepo] = [appImage, opsImage].map((i) => i.slice(0, i.lastIndexOf(':')));
  const q = shQuote;
  const bind = bindHost !== null
    ? `BIND=${q(bindHost)}\n`
    : `BIND="$(hostname -I </dev/null 2>/dev/null | tr ' ' '\\n' | grep -E '^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)' | head -n 1 || true)"
if ! [[ "$BIND" =~ ^[0-9]{1,3}(\\.[0-9]{1,3}){3}$ ]]; then
  echo "this machine has no private network address (10.x, 172.16-31.x or 192.168.x) to show the preview on; set its host to its IP address in the config" >&2; exit 1
fi
`;
  const env = [
    ['COMPOSE_PROJECT_NAME', q(project)], ['APP_IMAGE', q(appRepo)], ['OPS_IMAGE', q(opsRepo)], ['APP_TAG', q(runId)],
    ['INSTANCE_MODE', q('demo')], ['SMTP_URL', q('smtp://mailpit:1025')], ['EMAIL_FROM', q('preview@example.invalid')],
    ['BACKUP_REPOSITORY', q('/preview-has-no-backups')], ['HTTP_PORT', `"$BIND:"${q(String(port))}`], ['HTTPS_PORT', q(`127.0.0.1:${port + 1}`)],
  ];
  return `set -euo pipefail
ROOT=${q(root)}
P=${q(project)}
DIR="$ROOT/runs/$P"
${bind}mkdir -p "$DIR/src" "$DIR/bundle"
tar -xzf "$DIR/source.tar.gz" -C "$DIR/src"
echo HF-STEP building
cd "$DIR/src"
docker build -q -f deploy/Dockerfile -t ${q(appImage)} --build-arg ${q(`APP_VERSION=${version}`)} --build-arg ${q(`GIT_COMMIT=${commit}`)} . </dev/null >/dev/null
docker build -q -f deploy/ops.Dockerfile -t ${q(opsImage)} --build-arg ${q(`APP_VERSION=${version}`)} --build-arg ${q(`GIT_COMMIT=${commit}`)} . </dev/null >/dev/null
cp deploy/compose.yaml deploy/Caddyfile "$DIR/bundle/"
docker run --rm -u "$(id -u):$(id -g)" -v "$DIR/bundle:/out" ${q(opsImage)} init --client ${q(client)} --origin ${q(origin)} --site :80 --dir "$DIR/bundle" --demo --out /out/.env </dev/null 2>"$DIR/init.err" \\
  || { cat "$DIR/init.err" >&2; exit 1; }
${SETENV_FN}${env.map(([k, v]) => `setenv ${k} ${v}`).join('\n')}
cat > "$DIR/bundle/compose.override.yaml" <<'YAML'
# Preview only: Mailpit catches the app's mail.
services:
  mailpit: { image: ${MAILPIT_IMAGE}, networks: [backend] }
YAML
echo HF-STEP starting
cd "$DIR/bundle"
docker compose -p "$P" up -d proxy mailpit </dev/null
t=0
until curl -fsS "http://$BIND:"${q(`${port}/healthz`)} </dev/null 2>/dev/null | grep -q '"ok"'; do
  t=$((t + 2)); if [ "$t" -ge 300 ]; then echo "the app did not answer /healthz within 5 minutes" >&2; exit 1; fi
  sleep 2
done
echo HF-STEP seeding
docker compose -p "$P" exec -T app node apps/server/dist/seed/cli.js </dev/null > "$DIR/seed.txt"
echo HF-DEMO-UP
cat "$DIR/seed.txt"
`;
}

const lastStep = (stdout) => {
  const steps = String(stdout ?? '').split('\n').filter((l) => l.startsWith('HF-STEP ')).map((l) => l.slice(8).trim());
  return steps.at(-1) || 'preparing';
};
const lastErrLine = (stderr) => {
  const lines = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return redact(lines.at(-1) ?? 'no error text').slice(0, 300);
};

export async function bringUpDemo({ machine, appDir, sha, slug, runId, client, ssh, git = gitFn, tmpDir = os.tmpdir() }) {
  if (typeof sha !== 'string' || !COMMIT_RE.test(sha)) throw new MachineError('failed', `The preview cannot start: "${sha}" is not a commit.`);
  const project = composeProjectOf(slug, runId);
  const tail = `/runs/${project}`;
  const runDir = assertSafe('path', machine.runDir);
  if (!runDir.endsWith(tail)) throw new MachineError('failed', `The preview cannot start: the machine's run folder ${runDir} is not the one for ${project}.`);
  const root = runDir.slice(0, -tail.length);
  const host = machine.host;
  const lost = () => new MachineError('unreachable', `Conductor lost its SSH connection to ${host} while starting the preview.`);

  const pkg = await git(appDir, ['show', `${sha}:package.json`]);
  let version;
  try { version = JSON.parse(pkg.stdout).version; } catch { version = undefined; }
  if (pkg.code !== 0 || typeof version !== 'string') throw new MachineError('failed', `The preview cannot start: the app's package.json at ${sha.slice(0, 7)} has no version.`);

  const dir = mkdtempSync(path.join(tmpDir, 'hf-src-'));
  const tarball = path.join(dir, `hf-src-${runId}.tar.gz`);
  try {
    const ar = await git(appDir, ['archive', '--format=tar.gz', '-o', tarball, sha]);
    if (ar.code !== 0) throw new MachineError('failed', `The preview cannot start: Conductor could not pack the app at ${sha.slice(0, 7)} (${lastErrLine(ar.stderr)}).`);
    const mk = await ssh.exec(machine, `set -eu; mkdir -p ${shQuote(runDir)}`);
    if (unreachable(mk)) throw lost();
    if (mk.code !== 0) throw new MachineError('failed', `The preview did not start: Conductor could not make the run folder on ${host} (${lastErrLine(mk.stderr)}).`);
    const up = await ssh.upload(machine, tarball, `${runDir}/source.tar.gz`);
    if (unreachable(up)) throw lost();
    if (up.code !== 0) throw new MachineError('failed', `The preview did not start: Conductor could not copy the app to ${host} (${lastErrLine(up.stderr)}).`);

    const port = machine.previewPort;
    const bindHost = IPV4_RE.test(host) && host !== '0.0.0.0' ? host : null; // null: the script finds the box's private address
    const origin = `http://${host}${port === 80 ? '' : `:${port}`}`;
    const script = demoUpScript({ root, project, slug, runId, client, origin, bindHost, port, version, commit: sha.slice(0, 7) });
    const r = await ssh.exec(machine, script, { timeoutMs: 45 * 60_000 });
    if (unreachable(r)) throw lost();
    const { marker, rest } = parseMarker(r.stdout);
    if (r.code === 0 && marker === 'HF-DEMO-UP') return { url: `${origin}/`, seedText: rest };
    throw new MachineError('failed', `The preview did not start (while ${lastStep(r.stdout)}): ${lastErrLine(r.stderr)}.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
