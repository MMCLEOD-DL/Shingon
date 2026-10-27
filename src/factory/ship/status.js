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
import { readUpdateExit } from './update.js';
import { SHIP_EXIT } from './outcomes.js';

const clean = (s, max = 400) => String(redact(terminalText(s))).slice(0, max);
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
// pendingCheck reasons where Conductor never saw the update end (Ruling S21).
const UNSEEN_END = new Set(['in-progress', 'lost-contact', 'interrupted']);

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

    // 5. Pending check (Ruling 6, S19, S21): resolved only by seeing a known version AND passing checks, and, when
    // Conductor never saw the update end, only once it has provably finished (the box runs its version, or its exit
    // file was read). Until then the box may simply not have got there yet.
    if (dep.pendingCheck) {
      const pc = dep.pendingCheck;
      const finished = seen && box.checks?.ok && lock
        ? !UNSEEN_END.has(pc.why) || seen === pc.version || (await readUpdateExit(targetOf(dep), { dir: dep.bundleDir, runId: pc.runId, env })).read
        : false;
      if (seen && box.checks?.ok && lock && !finished) {
        fail('an update may still be running');
        lines.push(`The last update's result is still not clear: the box runs ${seen}, not ${clean(pc.version ?? 'the new version', 40)}, and the update's result was not found, so an update may still be running. Wait a few minutes, then run this again.`);
      } else if (finished) {
        const from = dep.currentVersion;
        const foundationNow = seen === pc.version ? pc.foundation : dep.foundation;
        const withHistory = addHistory(dep, { version: seen, from, outcome: 'confirmed', at: now(),
          detail: `After an update whose end Conductor did not see, the box was found running ${seen} and healthy.` });
        save({ pendingCheck: null, currentVersion: seen, foundation: foundationNow, history: withHistory.history });
        lines.push(`The last update's result is now known: the box runs ${seen} and is healthy. Shipping to it is allowed again.`);
      } else if (seen && box.checks?.ok && !lock) {
        fail("the last update's result is still not clear");
        lines.push("The last update's result is still not clear: a ship to this box is running, so it was not checked off.");
      } else {
        fail("the last update's result is still not clear");
        lines.push(`The last update's result is still not clear: ${seen ? "the box's checks do not all pass" : 'the box did not report its version'}. Follow RUNBOOK.md on the box ("Recovering from a failed update"), then run this again.`);
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
