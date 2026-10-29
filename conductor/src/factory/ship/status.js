// `conductor deployments [status]` (Contract 7 §7.11): what each deployment runs (records only), and what each box says now.
// Status only looks at a box (Task 5's probe); the one thing it writes is the deployment record, under the deployment's lock.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../../exec.js';
import { strictChildEnv, redact } from '../../secrets.js';
import { terminalText } from '../brief.js';
import { parseVersion, compareVersions, securityFixesSince } from '../foundationLog.js';
import { addHistory, saveDeployment, loadDeployment, lockDeployment, listDeployments } from '../deployments/store.js';
import { targetOf, missingTools } from './remote.js';
import { probeBox } from './probe.js';
import { readUpdateRun, readRecoveryRecord } from './update.js';
import { SHIP_EXIT, interpretUpdate } from './outcomes.js';

const clean = (s, max = 400) => String(redact(terminalText(s))).slice(0, max);
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

const UK_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export function ukTime(iso) {
  const d = new Date(iso);
  if (typeof iso !== 'string' || Number.isNaN(d.getTime())) return clean(iso ?? 'an unknown time', 60);
  return UK_TIME.format(d).replace(/(\d{4}) at /, '$1, ').replace(/(\d{4}) (\d\d:\d\d)$/, '$1, $2');
}

const HOSTING = { 'client-box': 'client box', 'operator-server': 'operator server' };
const ACCESS = { 'cloudflare-tunnel': 'Cloudflare tunnel', tailscale: 'Tailscale', ssh: 'SSH' };

export function listText(entries) {
  if (!entries.length) return 'No deployments yet. Ship one with: conductor ship <project> --to <deployment>';
  const sorted = [...entries].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.map((e) => {
    const id = `${e.slug}/${e.name}`;
    const d = e.deployment;
    if (e.problem || !d) return `${id}  ${clean(e.problem ?? 'The deployment record could not be read.', 600)}`;
    if (d.setup.step !== 'done') return `${id}  first-time setup not finished (stopped after: ${d.setup.step})`;
    const last = d.history.at(-1);
    const parts = [`${d.currentVersion ?? 'unknown version'} on foundation ${d.foundation ?? 'unknown'}`,
      `${HOSTING[d.hosting] ?? d.hosting}, ${ACCESS[d.access] ?? d.access}`,
      last ? `last: ${last.outcome}, ${ukTime(last.at)}` : 'last: nothing recorded yet'];
    return `${id}  ${parts.join('  ')}${d.pendingCheck ? '  result of the last update unknown: run conductor deployments status' : ''}`;
  }).join('\n');
}

export function statusText(reports) {
  const blocks = reports.map((r) => [`${r.ok ? '✓' : '✗'} ${r.slug}/${r.name}`, ...r.lines.map((l) => `  ${l}`)].join('\n'));
  const bad = reports.filter((r) => !r.ok).length;
  const tail = bad === 0 ? 'All deployments are healthy and up to date.' : `${bad} of ${reports.length} deployments need attention.`;
  return `${blocks.join('\n\n')}${blocks.length ? '\n\n' : ''}${tail}`;
}

function runLine(label, run) {
  if (!run || !run.last) return { line: `${label}: none yet.`, ok: false, problem: `${label.toLowerCase()}: none yet` };
  const when = ukTime(run.last.at);
  if (run.last.ok) return { line: `${label}: ${when}, worked.`, ok: true };
  const detail = run.last.detail || 'no reason given';
  const good = run.lastOk ? ` (the last one that worked: ${ukTime(run.lastOk.at)})` : '';
  return { line: `${label}: ${when}, failed: ${detail}${good}`, ok: false, problem: `${label.toLowerCase()} failed: ${detail}` };
}

export async function deploymentStatus(entry, { foundation, env = process.env, now = () => new Date().toISOString(), isAlive } = {}) {
  const { slug, name } = entry;
  const report = (ok, lines, dep = entry.deployment) => ({ slug, name, ok, lines, dep });
  if (entry.problem || !entry.deployment) return report(false, [clean(entry.problem ?? 'The deployment record could not be read.', 600)], null);
  let dep = entry.deployment;
  if (dep.setup.step !== 'done') {
    return report(false, [`First-time setup is not finished (stopped after: ${dep.setup.step}). Run: conductor ship ${slug} --to ${name}`]);
  }

  // The lock keeps a ship from starting mid-look, and the record is re-read under it so nothing newer is overwritten.
  let lock = null;
  try { lock = lockDeployment(entry.projectDir, name, isAlive ? { isAlive } : {}); } catch { lock = null; }
  const lines = [];
  const problems = [];
  let ok = true;
  const fail = (why) => { ok = false; if (why) problems.push(clean(why, 300)); };
  try {
    if (lock) { try { dep = loadDeployment(entry.projectDir, name) ?? dep; } catch { /* keep the listed record */ } }
    const save = (patch) => {
      if (!lock) return;
      dep = { ...dep, ...patch };
      saveDeployment(entry.projectDir, dep);
    };

    const box = await probeBox(targetOf(dep), dep, { env });
    if (!box.reachable) {
      const p = clean(box.problem ?? 'The box could not be reached.', 600);
      lines.push(p);
      fail(p);
      finishSave();
      return report(false, lines, dep);
    }

    // 4. Version.
    const seen = box.version?.app ?? null;
    if (seen) {
      lines.push(`Running ${seen} on foundation ${dep.foundation ?? 'unknown'}.`);
      if (!dep.pendingCheck && seen !== dep.currentVersion) {
        lines.push(`The box runs ${seen}, but Conductor's record said ${dep.currentVersion ?? 'nothing'}. ${lock ? 'The record has been corrected.' : 'The record was not corrected (see below).'}`);
        save({ currentVersion: seen });
      }
    } else {
      lines.push(`The box did not report which version it runs. Conductor's record says ${dep.currentVersion ?? 'nothing'}.`);
      fail('the box did not report its version');
    }
    for (const n of box.notes) { lines.push(clean(n, 600)); problems.push(clean(n, 300)); }

    // 5. Pending check (Ruling 6, S19, S21, S22): status never looks calmer than the box is. It is cleared only under the
    // lock, with a known version and passing checks, and only once how the update ended is known: the run's own exit code and
    // log (interpreted exactly as a ship would, never taken as 'confirmed'), or, for an urgent one, the foundation's own record.
    if (dep.pendingCheck) {
      const pc = dep.pendingCheck;
      const healthy = Boolean(seen && box.checks?.ok);
      const unclear = (text) => { fail("the last update's result is still not clear"); lines.push(`The last update's result is still not clear: ${text}`); };
      const notHealthy = () => (seen ? "the box's checks do not all pass" : 'the box did not report its version');
      const recover = `Follow "Recovering from a failed update" in RUNBOOK.md in ${dep.bundleDir} on the box, then run there: docker compose run --rm updater update --mark-recovered. Then run this again.`;
      const settle = (patch, outcome, text, line) => {
        const withHistory = addHistory(dep, { version: seen, from: dep.currentVersion, outcome, at: now(), detail: text.split('\n')[0] });
        save({ pendingCheck: null, ...patch, history: withHistory.history });
        lines.push(line);
      };
      if (!lock) {
        unclear(healthy ? 'a ship to this box is running, so it was not checked off.' : `${notHealthy()}. Follow RUNBOOK.md on the box ("Recovering from a failed update"), then run this again.`);
      } else if (pc.why === 'urgent') {
        // Healthy checks alone never clear it: only the foundation's own record (marked as recovered on the box) does.
        const rec = await readRecoveryRecord(targetOf(dep), dep, { env });
        if (rec.read && rec.recovered && healthy) {
          settle({ currentVersion: seen, foundation: seen === pc.version ? pc.foundation : dep.foundation }, 'confirmed',
            `The box's own record shows no failed update left to recover (it was marked as recovered); the box runs ${seen} and is healthy.`,
            `The box's own record shows no failed update left to recover, and the box runs ${seen} and is healthy. Shipping to it is allowed again.`);
        } else {
          fail('the last update needs recovering by hand');
          const why = !rec.read ? "the box's own record of it could not be read"
            : !rec.recovered ? "the box's own record says it has not been marked as recovered" : notHealthy();
          lines.push(`URGENT: the last update to ${clean(pc.version ?? 'a new version', 40)} failed and could not be undone, or was left half done (${why}). ${recover}`);
        }
      } else {
        await unseenEnd({ pc, seen, healthy, save, unclear, notHealthy, settle, recover });
      }
    }

    // 6. Health.
    if (box.checks?.ok) lines.push('Health: every check passes.');
    else if (box.checks) {
      lines.push('Health: problems found:');
      for (const f of box.checks.failing) { lines.push(`  - ${f}`); problems.push(f); }
      if (!box.checks.failing.length) lines.push('  - the box reported a problem without saying which');
      fail('health checks failing');
    } else fail('the checks could not run');

    // 7. Backups.
    if (box.runs) {
      for (const [label, run] of [['Last backup', box.runs.backup], ['Last restore test', box.runs.restoreTest]]) {
        const r = runLine(label, run);
        lines.push(r.line);
        if (!r.ok) fail(r.problem);
      }
    } else fail('the backup records could not be read');

    // 8. Security fixes since the foundation Conductor recorded (never the box's own claim).
    if (!foundation?.ok) {
      const p = clean(foundation?.problem ?? 'the foundation was not looked up', 600);
      lines.push(`Security fixes: could not tell (${p})`);
      fail(`security fixes: could not tell (${p})`);
    } else if (!dep.foundation) {
      lines.push('Security fixes: could not tell (Conductor has no record of which foundation this app is built on).');
      fail('security fixes: no foundation on record');
    } else {
      let fixes = null;
      try { fixes = securityFixesSince(foundation.changelog, dep.foundation.slice(1)); } catch (err) {
        lines.push(`Security fixes: could not tell (${clean(err.message, 300)})`);
        fail('security fixes: could not tell');
      }
      if (fixes && fixes.length) {
        lines.push(`Behind on foundation security fixes (the newest foundation is ${foundation.version}):`);
        for (const f of fixes) for (const l of f.lines) lines.push(`  - ${f.version}: ${clean(l, 300)}`);
        lines.push(`  Bring them in with: conductor foundation-upgrade ${slug} --to v${foundation.version}, then ship.`);
        fail('behind on foundation security fixes');
      } else if (fixes) lines.push(`Security fixes: up to date with foundation ${foundation.version}.`);
    }

    // 9. The operator chose no outside watcher at first ship; a warning, not a failure.
    if (dep.alerts?.heartbeat === false) lines.push('Warning: there is no outside watcher (Uptime Kuma) for this box, so nobody notices if it goes off.');

    finishSave();
    return report(ok, lines, dep);
  } finally {
    lock?.release();
  }

  // A pendingCheck whose end Conductor never saw ('in-progress', 'lost-contact', 'interrupted', or anything unknown).
  async function unseenEnd({ pc, seen, healthy, save, unclear, notHealthy, settle, recover }) {
    const from = dep.currentVersion;
    const t = targetOf(dep);
    // With a run id the run is read even when the box runs the new version: an exit 3 after the switch must not hide.
    const run = pc.runId ? await readUpdateRun(t, { dir: dep.bundleDir, runId: pc.runId, env }) : { state: 'no-run-id' };
    if (run.state === 'exited') {
      const result = interpretUpdate({ code: run.code, output: terminalText(run.output), to: pc.version, from, name: t.label, bundleDir: dep.bundleDir });
      const text = clean(result.text, 2000);
      const said = text.split('\n');
      if (result.outcome === 'urgent') {
        fail('the last update needs recovering by hand');
        const withHistory = addHistory(dep, { version: pc.version, from, outcome: 'urgent', at: now(), detail: said[0] });
        save({ pendingCheck: { ...pc, why: 'urgent', since: now() }, history: withHistory.history });
        lines.push(...said);
        if (!/--mark-recovered/.test(text)) lines.push(recover);
        return;
      }
      if (result.outcome === 'lost-contact') return unclear("the update has ended, but what it said could not be understood. Look at the update's log on the box, then run this again.");
      const landed = result.outcome === 'updated' || result.outcome === 'already-on';
      const expected = landed ? pc.version : from;
      if (seen !== expected) {
        return unclear(`the update says it ended (${result.outcome}), so the box should run ${clean(expected ?? 'the old version', 40)}, but it reports ${seen ? clean(seen, 40) : 'no version'}: the two disagree. Check the box, then run this again.`);
      }
      if (!healthy) return unclear(`the update ended (${result.outcome}), but ${notHealthy()}.`);
      const patch = landed ? { currentVersion: pc.version, foundation: pc.foundation } : {};
      settle(patch, result.outcome, text, `The last update's result is now known: ${said[0]}`);
      lines.push(...said.slice(1));
      if (result.outcome === 'updated') lines.push('Conductor did not see this update end, so it did not bring in the new compose.yaml and Caddyfile: see RUNBOOK.md on the box, "Keeping a deployment patched".');
      lines.push('Shipping to it is allowed again.');
      return;
    }
    if (run.state === 'running') return unclear('the update\'s log is on the box but it has not finished, so an update may still be running. Wait a few minutes, then run this again.');
    if (run.state === 'never-started' && seen && seen === from) {
      if (!healthy) return unclear(`the update never started on the box, but ${notHealthy()}.`);
      const text = `The update to ${clean(pc.version ?? 'a new version', 40)} was cancelled: the update never started on the box, which still runs ${seen}.`;
      return settle({}, 'cancelled', text, `The last update's result is now known: ${text} Shipping to it is allowed again.`);
    }
    // No run on record to read (S21): the box provably running the new version, healthy, is the only way out.
    if ((run.state === 'no-run-id' || run.state === 'never-started') && healthy && seen === pc.version) {
      return settle({ currentVersion: seen, foundation: pc.foundation }, 'confirmed',
        `After an update whose end Conductor did not see, the box was found running ${seen} and healthy.`,
        `The last update's result is now known: the box runs ${seen} and is healthy. Shipping to it is allowed again.`);
    }
    if (!healthy) return unclear(`${notHealthy()}. Follow RUNBOOK.md on the box ("Recovering from a failed update"), then run this again.`);
    if (run.state === 'unknown') return unclear("the update's result could not be read from the box, so an update may still be running. Wait a few minutes, then run this again.");
    if (run.state === 'never-started') return unclear(`the update never started on the box, but it runs ${clean(seen, 40)}, not ${clean(from ?? 'the recorded version', 40)} or ${clean(pc.version ?? 'the new version', 40)}: the two disagree. Check the box, then run this again.`);
    return unclear(`the box runs ${seen}, not ${clean(pc.version ?? 'the new version', 40)}, and the update's result was not found, so an update may still be running. Wait a few minutes, then run this again.`);
  }

  function finishSave() {
    if (!lock) { lines.push('A ship to this box is running, so its record was not updated.'); return; }
    dep = { ...dep, lastStatus: { at: now(), app: dep.currentVersion, foundation: dep.foundation, ok, problems: problems.slice(0, 20) } };
    saveDeployment(entry.projectDir, dep);
  }
}

function httpsPrefix(repo) { return String(repo).startsWith('https://') ? ['-c', 'protocol.https.allow=always'] : []; }

/** The newest foundation release (plain x.y.z tag, never work in progress) and its CHANGELOG.md at that tag. */
export async function latestFoundation(repo, { env = process.env, run = runCommand } = {}) {
  const unreadable = { ok: false, problem: `The foundation repository at ${clean(repo, 200)} could not be read, so Conductor cannot tell which security fixes the apps are missing. Check factory.foundation.repo in the config.` };
  const genv = strictChildEnv({ env });
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete genv[k];
  genv.GIT_TERMINAL_PROMPT = '0';
  const git = (args, cwd) => run({ cmd: 'git', args, cwd, env: genv, timeoutMs: GIT_TIMEOUT_MS });
  let tmp = null;
  try {
    const ls = await git([...httpsPrefix(repo), 'ls-remote', '--tags', '--refs', '--', repo, 'v*']);
    if (ls.code !== 0) return unreadable;
    const versions = String(ls.stdout).split('\n').map((l) => /\trefs\/tags\/v(.+)$/.exec(l.trim() ? l : '')?.[1])
      .filter((v) => v && parseVersion(v) && parseVersion(v).pre.length === 0 && !v.includes('+'));
    if (!versions.length) return { ok: false, problem: `The foundation repository at ${clean(repo, 200)} has no release tags, so Conductor cannot tell which security fixes the apps are missing.` };
    const version = versions.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
    tmp = mkdtempSync(path.join(tmpdir(), 'cond-fnd-'));
    const dir = path.join(tmp, 'f');
    const tag = `v${version}`;
    const clone = await git([...httpsPrefix(repo), 'clone', '-q', '--depth', '1', '--branch', tag, '--no-checkout', '--', repo, dir]);
    if (clone.code !== 0) return unreadable;
    const show = await git(['-C', dir, 'show', `${tag}:CHANGELOG.md`]);
    if (show.code !== 0) return unreadable;
    return { ok: true, version, changelog: show.stdout };
  } catch {
    return unreadable;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

export async function deploymentsCommand(cli, ctx) {
  const print = (s) => ctx.stdout.write(`${redact(terminalText(s))}\n`);
  const entries = listDeployments(ctx.factory.projectsRoot, { slug: cli.slug });
  if (!cli.status) {
    print(listText(entries));
    return entries.some((e) => e.problem) ? SHIP_EXIT.notDone : SHIP_EXIT.done;
  }
  if (!entries.length) {
    print(cli.slug ? `No deployments found for ${cli.slug}.` : 'No deployments found.');
    return SHIP_EXIT.notDone;
  }
  const missing = missingTools(['ssh', 'git'], { env: ctx.env });
  if (missing.length) { print(`Conductor needs ${missing[0]} on this machine, and it is not installed.`); return SHIP_EXIT.notDone; }
  const foundation = await latestFoundation(ctx.factory.foundation.repo, { env: ctx.env });
  const reports = [];
  for (const e of entries) {
    try { reports.push(await deploymentStatus(e, { foundation, env: ctx.env })); } catch (err) {
      reports.push({ slug: e.slug, name: e.name, ok: false, lines: [`Conductor could not check this box: ${clean(err.message, 300)}`], dep: e.deployment });
    }
  }
  print(statusText(reports));
  return reports.every((r) => r.ok) ? SHIP_EXIT.done : SHIP_EXIT.notDone;
}
