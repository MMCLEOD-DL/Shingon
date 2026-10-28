// Later ships: once first-time setup is done, every ship is the foundation's own safe update
// (`docker compose run --rm updater update --to <v>`, Contract 4). Conductor never re-implements it: it starts it
// detached on the box (so a dropped connection or Ctrl-C cannot stop it half-way), passes its progress on, maps the
// outcome to plain English (Task 3's interpretUpdate) and records it. After a good update only, it brings in the new
// bundle's compose.yaml and Caddyfile the way RUNBOOK.md's "Keeping a deployment patched" says, and tidies old image files.
import { remoteRun, sshProblem } from './remote.js';
import { composeCmd } from './probe.js';
import { interpretUpdate } from './outcomes.js';
import { parseVersion } from '../foundationLog.js';
import { addHistory } from '../deployments/store.js';
import { assertSafe, shQuote } from '../remote.js';
import { RUN_ID_RE } from '../ids.js';
import { terminalText } from '../brief.js';
import { redact } from '../../secrets.js';
import { clean, firstLine } from './boxText.js';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FOUNDATION_RE = /^v\d+\.\d+\.\d+$/;
const MINUTE = 60000;

const why = (r) => firstLine(r.stderr) || `code ${r.code}`;
const files = (r) => ({ log: `.conductor/update-${r}.log`, exit: `.conductor/update-${r}.exit` });

function checkRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error(`"${runId}" is not a run id`);
  return runId;
}

// x.y.z with no pre-release or build part, so it is safe unquoted inside a `case` pattern.
function plainVersion(v) {
  const p = parseVersion(v);
  return p !== null && v === `${p.major}.${p.minor}.${p.patch}`;
}

// Starts the update in its own session on the box and returns once its log exists (waiting up to about 5 s).
// `unsure` = the update may or may not be running (the connection broke, or it was launched but wrote no log).
export async function startDetachedUpdate(t, { dir, version, imagesFile = null, runId, registry = false, env = process.env }) {
  const { log, exit } = files(checkRunId(runId));
  const cfg = registry ? 'DOCKER_CONFIG="$PWD/.docker" ' : '';
  const imageArg = imagesFile ? ` --image-file ${shQuote(imagesFile)}` : '';
  const inner = `${cfg}docker compose run --rm -T updater update --to ${shQuote(version)}${imageArg} > ${log} 2>&1; echo $? > ${exit}`;
  const cmd = `cd ${shQuote(assertSafe('path', dir))} && mkdir -p .conductor && rm -f ${exit} ${log} && `
    + `{ setsid nohup sh -c ${shQuote(inner)} >/dev/null 2>&1 </dev/null & } && echo launched && `
    + `{ i=0; while [ ! -f ${log} ] && [ "$i" -lt 5 ]; do sleep 1; i=$((i+1)); done; [ -f ${log} ]; }`;
  const r = await remoteRun(t, cmd, { env, timeoutMs: MINUTE });
  if (r.code === 0) return { ok: true, problem: null, unsure: false };
  if (r.unreachable) return { ok: false, problem: sshProblem(t, r), unsure: true };
  // Once launched, a missing log cannot prove nothing will happen (a slow start, or a failure hidden by /dev/null).
  if (/^launched$/m.test(String(r.stdout ?? ''))) {
    return { ok: false, problem: `Conductor started the update on ${t.label} but could not see it begin; check the box.`, unsure: true, launched: true };
  }
  return { ok: false, problem: `The update could not be started on ${t.label} (${why(r)}).`, unsure: false };
}

// Polls until the update writes its exit code, saying each new log line once. SSH failures are retried until the time is up.
export async function pollUpdate(t, { dir, runId, say = () => {}, env = process.env, updateTimeoutMs = 45 * MINUTE, pollMs = 5000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = Date.now }) {
  const { log, exit } = files(checkRunId(runId));
  const cmd = `cd ${shQuote(assertSafe('path', dir))} && if [ -f ${exit} ]; then echo "exit=$(cat ${exit})"; else echo exit=running; fi; cat ${log} 2>/dev/null`;
  const start = clock();
  let output = '';
  let said = 0;
  let toldLost = false;
  const sayNew = (complete) => {
    const lines = output.split('\n');
    const upTo = complete ? lines.length : lines.length - 1; // a running update's last line may be half written
    for (; said < upTo; said++) {
      const line = clean(lines[said]).trim();
      if (line) say(`  box: ${line}`);
    }
  };
  for (;;) {
    const r = await remoteRun(t, cmd, { env, timeoutMs: MINUTE });
    if (r.code === 0) {
      const text = String(r.stdout ?? '');
      const nl = text.indexOf('\n');
      const head = (nl === -1 ? text : text.slice(0, nl)).trim();
      const body = nl === -1 ? '' : text.slice(nl + 1);
      if (body.length >= output.length) output = body;
      const m = /^exit=(\d+)$/.exec(head);
      if (m) {
        sayNew(true);
        return { code: Number(m[1]), output, lostContact: false };
      }
      sayNew(false);
    } else if (!toldLost) {
      toldLost = true;
      say(`Conductor lost touch with ${t.label}; the update carries on there. Trying again…`);
    }
    if (clock() - start >= updateTimeoutMs) return { code: null, output, lostContact: true };
    await sleep(pollMs);
  }
}

// RUNBOOK.md, "Keeping a deployment patched", step 4: the new compose.yaml and Caddyfile go in only where the box's copy
// is still the previous bundle's, never over a hand edit; then the third-party images are pulled and the box restarted.
export async function refreshBundleFiles(t, dep, { version, env = process.env }) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error(`"${version}" is not a release version`);
  const dir = assertSafe('path', dep.bundleDir);
  const prev = typeof dep.bundleVersion === 'string' && VERSION_RE.test(dep.bundleVersion) ? dep.bundleVersion : null;
  const bundle = `.conductor/bundle-${version}`; // version is checked against VERSION_RE: digits, letters, '.', '-'
  const script = `cd ${shQuote(dir)} || exit 1
cp ${bundle}/RUNBOOK.md RUNBOOK.md; cp ${bundle}/.env.example .env.example
for f in compose.yaml Caddyfile; do
  new=${bundle}/$f; old=${prev ? `.conductor/bundle-${prev}/$f` : ''}
  if cmp -s "$f" "$new"; then echo "same=$f"
  elif [ -n "$old" ] && [ -f "$old" ] && cmp -s "$f" "$old"; then if cp "$new" "$f.conductor-tmp" && mv "$f.conductor-tmp" "$f"; then echo "replaced=$f"; else echo "failed=$f"; fi
  else echo "hand=$f"; fi
done`;
  const where = (f) => `${dir}/${bundle}/${f}`;
  const r = await remoteRun(t, script, { env, timeoutMs: 2 * MINUTE });
  if (r.code !== 0) {
    const reason = r.unreachable ? sshProblem(t, r).replace(/\.$/, '') : why(r);
    return { warnings: [`Conductor could not check whether compose.yaml and Caddyfile on the box need the new versions (${reason}). The new ones are in ${dir}/${bundle}/: see RUNBOOK.md, "Keeping a deployment patched".`] };
  }
  const status = {};
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = /^(same|replaced|hand|failed)=(compose\.yaml|Caddyfile)$/.exec(line.trim());
    if (m) status[m[2]] = m[1];
  }
  const warnings = [];
  const replaced = [];
  for (const f of ['compose.yaml', 'Caddyfile']) {
    const s = status[f];
    if (s === 'replaced') replaced.push(f);
    else if (s === 'hand') warnings.push(`${f} on the box was changed by hand, so Conductor left it alone. The new one is at ${where(f)}: merge it by hand (RUNBOOK.md, "Keeping a deployment patched").`);
    else if (s !== 'same') warnings.push(`The new ${f} could not be put in place on the box. It is at ${where(f)}: copy it in by hand (RUNBOOK.md, "Keeping a deployment patched").`);
  }
  if (replaced.length) {
    const pull = await remoteRun(t, composeCmd(dep, `pull db proxy${dep.access === 'cloudflare-tunnel' ? ' tunnel' : ''}`), { env, timeoutMs: 30 * MINUTE });
    const up = pull.code === 0 ? await remoteRun(t, composeCmd(dep, 'up -d'), { env, timeoutMs: 10 * MINUTE }) : null;
    const bad = pull.code !== 0 ? pull : up.code !== 0 ? up : null;
    if (bad) {
      const reason = bad.unreachable ? sshProblem(t, bad).replace(/\.$/, '') : why(bad);
      warnings.push(`The new ${replaced.join(' and ')} ${replaced.length > 1 ? 'are' : 'is'} in place, but the box could not restart with them (${reason}). On the box run: docker compose up -d`);
    }
  }
  return { warnings };
}

// Status (Ruling S22): what the detached update left on the box, read in one call shaped like pollUpdate's.
// startDetachedUpdate removes both files, then the detached shell creates the log at once and the exit file at the end, so:
// 'exited' (with the code and the log) once the exit file holds a code; 'running' while the log is there without one (or the
// code is still being written); 'never-started' when neither file is there; 'unknown' when it could not be read.
export async function readUpdateRun(t, { dir, runId, env = process.env }) {
  const unknown = { state: 'unknown', code: null, output: '' };
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return unknown;
  const { log, exit } = files(runId);
  const cmd = `cd ${shQuote(assertSafe('path', dir))} && if [ -f ${exit} ]; then echo "exit=$(cat ${exit})"; elif [ -f ${log} ]; then echo exit=running; else echo exit=none; fi; cat ${log} 2>/dev/null; true`;
  const r = await remoteRun(t, cmd, { env, timeoutMs: MINUTE });
  if (r.code !== 0) return unknown;
  const text = String(r.stdout ?? '');
  const nl = text.indexOf('\n');
  const head = (nl === -1 ? text : text.slice(0, nl)).trim();
  const output = nl === -1 ? '' : text.slice(nl + 1);
  const m = /^exit=(\d*|running|none)$/.exec(head);
  if (!m) return unknown;
  if (/^\d+$/.test(m[1])) return { state: 'exited', code: Number(m[1]), output };
  if (m[1] === 'none') return { state: 'never-started', code: null, output: '' };
  return { state: 'running', code: null, output };
}

// The foundation's own rule for "an update could not be undone and has not been marked as recovered" (ops/src/runs.ts
// outstandingUpdate, the same as the app's /readyz update check): a failed, not-busy update run carrying the URGENT mark,
// newer than the last good one. `update --mark-recovered` records a good update run, which ends it.
export const OUTSTANDING_SQL = `select 'outstanding=' || count(*) from ops_runs where kind = 'update' and not ok and not busy
 and position('URGENT: update to' in detail) > 0
 and at > coalesce((select max(at) from ops_runs where kind = 'update' and ok), '-infinity'::timestamptz)`;
// The updater's record of an update that stopped part-way, in /state (ops/src/journal.ts UPDATE_RECORD next to OPS_WORK_DIR);
// `--mark-recovered` deletes it.
const RECORD_SCRIPT = 'f="$(dirname "${OPS_WORK_DIR:-/state/work}")/update-in-progress.json"; if [ -e "$f" ]; then echo record=yes; else echo record=no; fi';

// Status (Ruling S22): whether the foundation's own records still hold an unrecovered update. { read: true, recovered }
// only when both were read; anything else is { read: false } (and the caller stays blocked).
export async function readRecoveryRecord(t, dep, { env = process.env } = {}) {
  const no = { read: false, recovered: false };
  const q = await remoteRun(t, composeCmd(dep, `exec -T db psql -U app -d app -At -c ${shQuote(OUTSTANDING_SQL)}`), { env, timeoutMs: MINUTE });
  const n = q.code === 0 ? /^outstanding=(\d+)$/m.exec(String(q.stdout ?? '')) : null;
  if (!n) return no;
  const j = await remoteRun(t, composeCmd(dep, `run --rm --no-deps -T --entrypoint sh ops -c ${shQuote(RECORD_SCRIPT)}`), { env, timeoutMs: 2 * MINUTE });
  const rec = j.code === 0 ? /^record=(yes|no)$/m.exec(String(j.stdout ?? '')) : null;
  if (!rec) return no;
  return { read: true, recovered: Number(n[1]) === 0 && rec[1] === 'no' };
}

// Removes old images-<v>.tar files, always keeping the new version's and the one an undo would go back to.
export async function pruneImageFiles(t, { dir, version, from, env = process.env }) {
  if (!plainVersion(version) || !plainVersion(from)) return { ok: true, skipped: true, problem: null };
  const cmd = `cd ${shQuote(assertSafe('path', dir))} && for f in images-*.tar; do case "$f" in images-${version}.tar|images-${from}.tar) ;; *) rm -f -- "$f" ;; esac; done`;
  const r = await remoteRun(t, cmd, { env, timeoutMs: 2 * MINUTE });
  if (r.code === 0) return { ok: true, skipped: false, problem: null };
  return { ok: false, skipped: false, problem: `Old image files on the box could not be tidied away (${why(r)}); they can be deleted by hand from ${dir}.` };
}

export async function runLaterShip({ dep, target, version, foundation, imagesFile, runId, say = () => {}, save, env = process.env,
  now = () => new Date().toISOString(), opts = {} }) {
  const { updateTimeoutMs = 45 * MINUTE, pollMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = Date.now } = opts;
  checkRunId(runId);
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error(`"${version}" is not a release version`);
  if (typeof foundation !== 'string' || !FOUNDATION_RE.test(foundation)) throw new Error(`"${foundation}" is not a foundation tag`);
  if (dep.setup?.step !== 'done') throw new Error(`${dep.name} is not set up yet; the first ship is the setup`);
  if (dep.pendingCheck) throw new Error(`the last update to ${dep.name} has not been checked; run conductor deployments status first`);
  const registry = dep.imageDelivery === 'registry';
  if (!registry && imagesFile !== `images-${version}.tar`) throw new Error(`unsafe images file: ${JSON.stringify(imagesFile)}`);

  const t = target;
  const dir = assertSafe('path', dep.bundleDir);
  const from = dep.currentVersion;
  const record = (d, outcome, text) => save(addHistory(d, { at: now(), version, from, outcome, detail: String(text).split('\n')[0] }));
  const blocked = `Conductor will not ship to ${t.label} again until conductor deployments status has seen how it ended.`;

  // Ruling S19: saved before the box is touched, so a Ctrl-C or crash from here on still blocks the next ship until
  // conductor deployments status has seen how it ended. Every recorded outcome below replaces or clears it.
  const before = dep;
  save({ ...before, pendingCheck: { since: now(), version, foundation, why: 'in-progress', runId } });
  const settled = { ...before, pendingCheck: null };
  const pending = (why) => ({ ...settled, pendingCheck: { since: now(), version, foundation, why, runId } });

  say(`Updating ${t.label} to ${version} through the box's own safe update…`);
  const started = await startDetachedUpdate(t, { dir, version, imagesFile: registry ? null : imagesFile, runId, registry, env });
  if (!started.ok) {
    if (started.unsure) {
      const text = redact(started.launched
        ? `${started.problem} ${blocked}`
        : `Conductor lost touch with ${t.label} while starting the update to ${version}, so it cannot tell whether the update started. ${started.problem} ${blocked}`);
      return { outcome: 'lost-contact', text, dep: record(pending('lost-contact'), 'lost-contact', text) };
    }
    const text = redact(`${started.problem} Nothing was changed.`);
    return { outcome: 'cancelled', text, dep: record(settled, 'cancelled', text) };
  }

  const polled = await pollUpdate(t, { dir, runId, say, env, updateTimeoutMs, pollMs, sleep, clock });
  const result = polled.lostContact
    ? interpretUpdate({ code: null, output: '', to: version, from, name: t.label, bundleDir: dir })
    : interpretUpdate({ code: polled.code, output: terminalText(polled.output), to: version, from, name: t.label, bundleDir: dir });
  const outcome = result.outcome;
  let text = clean(result.text);

  if (outcome === 'lost-contact') {
    text = `${text}\nThe update carries on by itself on the box; ${blocked}`;
    return { outcome, text, dep: record(pending('lost-contact'), outcome, text) };
  }
  if (outcome === 'urgent') return { outcome, text, dep: record(pending('urgent'), outcome, text) };
  if (outcome === 'already-on') return { outcome, text, dep: record({ ...settled, currentVersion: version, foundation }, outcome, text) };
  if (outcome !== 'updated') return { outcome, text, dep: record(settled, outcome, text) };

  // Conductor's record of the foundation comes from the release (project.json), never from the box's claim.
  let saved = record({ ...settled, currentVersion: version, foundation }, outcome, text);
  const { warnings } = await refreshBundleFiles(t, saved, { version, env });
  const pruned = await pruneImageFiles(t, { dir, version, from, env });
  if (!pruned.ok) warnings.push(pruned.problem);
  saved = save({ ...saved, bundleVersion: version });
  for (const w of warnings) text += `\nNote: ${clean(w)}`;
  return { outcome, text, dep: saved };
}
