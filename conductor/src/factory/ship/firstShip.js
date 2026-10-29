// The first ship to a deployment: the runbook's "Setting up a new deployment", step by step, on the box.
// The foundation's own tools do the work (docker load, ops init --out, docker compose up -d, ops backup,
// ops restore-test, ops check, bootstrap-admin.js); Conductor fills in what ops init's checklist asks for,
// writing it into .env through standard input only. Each finished step is saved in the deployment record, so
// a failure or an interrupted run carries on from where it stopped without repeating ops init (plan Ruling 7).
import { remoteRun, sshProblem } from './remote.js';
import { composeCmd, probeVersion, probeBox } from './probe.js';
import { assertRef } from './build.js';
import { baseSettings, initArgs } from './setupPlan.js';
import { setEnv, readBackupPassword } from './envFile.js';
import { SETUP_STEPS, withStep, addHistory, validOrigin } from '../deployments/store.js';
import { assertSafe, shQuote } from '../remote.js';
import { terminalText } from '../brief.js';
import { redact, rememberSecret } from '../../secrets.js';
import { firstLine, lastLine } from './boxText.js';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FOUNDATION_RE = /^v\d+\.\d+\.\d+$/;
const IMAGES_FILE_RE = /^images-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tar$/;
// What Caddy's front door answers to: ":80", a host name, or a scheme and host. Never a leading "-".
const SITE_RE = /^(?::\d{1,5}|[A-Za-z0-9][A-Za-z0-9.:/*-]{0,252})$/;
const REG_USER_RE = /^[^\s\x00-\x1f\x7f-][^\s\x00-\x1f\x7f]{0,127}$/;
const MINUTE = 60000;

const minutes = (ms) => { const n = Math.max(1, Math.round(ms / MINUTE)); return `${n} minute${n === 1 ? '' : 's'}`; };

// The URL characters of RFC 3986: anything else after the link (an escape sequence from the box) is not part of it.
const LINK_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;

const interruptedInit = (dir, label, dep) => `An .env appeared in ${dir} on ${label} after the bundle was delivered, probably from an ops init that was interrupted, so nothing was changed. `
  + `Check that .env on the box; if it is not a live deployment's, move it aside (for example: mv .env .env.interrupted), then run the ship again: conductor ship ${dep.project} --to ${dep.name}`;
const notOurs = (dir, label) => `The folder ${dir} on ${label} already holds a deployment that Conductor did not set up, so nothing was changed. Choose another folder, or move that one away.`;

function passwordBlock(client, name, password) {
  return [
    `Save this backup password in your password manager now, under "${client} – ${name} backups".`,
    'Without it the backups cannot be read, and it must not live only on the box.',
    '',
    `    ${password}`,
    '',
    "Conductor will not show it again and keeps no copy. Clear your terminal's scrollback once it is saved.",
  ].join('\n');
}

// ops init's arguments, each checked before it goes onto a remote command line (Ruling S12, S17). null = refused.
function checkedInitArgs(dep, brief) {
  const client = brief?.client;
  try { assertSafe('client', client); } catch { return { problem: "The client's name in the brief cannot be given to ops init (it is empty, too long or holds control characters)." }; }
  if (client.trim() === '' || client.trim().startsWith('-')) return { problem: "The client's name in the brief cannot be given to ops init." };
  if (!validOrigin(dep.origin)) return { problem: `The web address ${firstLine(dep.origin)} cannot be given to ops init.` };
  if (dep.access !== 'cloudflare-tunnel' && !(typeof dep.site === 'string' && SITE_RE.test(dep.site))) {
    return { problem: `The site address ${firstLine(dep.site)} cannot be given to ops init.` };
  }
  return { args: initArgs(dep, brief) };
}

function alertsLine(a) {
  const room = a?.matrix ? firstLine(a.matrix.roomId) : null;
  if (room && a.webhook) return `Alerts go to Matrix (${room}) and to the webhook.`;
  if (room) return `Alerts go to Matrix (${room}).`;
  if (a?.webhook) return 'Alerts go to the webhook.';
  return 'No alert route is set.';
}

export async function runFirstSetup({
  dep, brief, target, ask, version, foundation, images, imagesFile, facts, settings, save,
  env = process.env, now = () => new Date().toISOString(), opts = {},
}) {
  const { startTimeoutMs = 10 * MINUTE, pollMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error(`"${version}" is not a release version`);
  if (typeof foundation !== 'string' || !FOUNDATION_RE.test(foundation)) throw new Error(`"${foundation}" is not a foundation tag`);
  if (dep.setup.step === 'done') throw new Error(`${dep.name} is already set up; a later ship is an update`);
  assertRef(images.opsRef);
  const registry = dep.imageDelivery === 'registry';
  if (!registry && imagesFile != null && !IMAGES_FILE_RE.test(imagesFile)) throw new Error(`unsafe images file: ${JSON.stringify(imagesFile)}`);

  const t = target;
  const label = t.label;
  const dir = assertSafe('path', dep.bundleDir);
  const cd = `cd ${shQuote(dir)} && `;
  const run = (command, o = {}) => remoteRun(t, command, { env, ...o });
  const say = (s) => ask.say(s);
  const idx = (s) => SETUP_STEPS.indexOf(s);
  const at = (step) => idx(dep.setup.step) < idx(step);
  const finish = (step) => { dep = save(withStep(dep, step, now())); };
  const partway = (reason) => ({
    outcome: 'partway',
    text: `${redact(reason)}\nRun the same command again to carry on from here: conductor ship ${dep.project} --to ${dep.name}`,
    dep,
  });
  const stopped = () => ({ outcome: 'stopped', text: notOurs(dir, label), dep });
  const why = (r, text) => (r.unreachable ? sshProblem(t, r) : text);

  // Step 1's copy and image load; both are safe to repeat. Returns a reason, or null when done.
  const putInPlace = async () => {
    const from = ['compose.yaml', 'Caddyfile', '.env.example', 'RUNBOOK.md'].map((f) => `.conductor/bundle-${version}/${f}`).join(' ');
    let r = await run(`${cd}cp ${from} .`); // version is checked against VERSION_RE above: digits, dots, letters, '-'
    if (r.code !== 0) return why(r, `The bundle files for ${version} could not be put in place on ${label} (${firstLine(r.stderr) || `code ${r.code}`}).`);
    if (registry) {
      const { host, user } = dep.registry;
      if (typeof user !== 'string' || !REG_USER_RE.test(user)) return 'The registry user name in the deployment record cannot be used on the box.';
      const password = await ask.secret(`Registry password for ${user} at ${host}`);
      if (password === null || password === '') return 'Stopped: no registry password was given.';
      rememberSecret(password);
      say(`Signing ${label} in to ${host}…`);
      r = await run(`${cd}docker --config "$PWD/.docker" login ${shQuote(host)} -u ${shQuote(user)} --password-stdin`, { input: password, timeoutMs: 2 * MINUTE });
      if (r.code !== 0) return why(r, `${label} could not sign in to ${host} (${firstLine(r.stderr) || `code ${r.code}`}).`);
      say(`Fetching the ops image on ${label}…`);
      r = await run(`${cd}DOCKER_CONFIG="$PWD/.docker" docker pull ${shQuote(images.opsRef)}`, { timeoutMs: 30 * MINUTE });
      if (r.code !== 0) return why(r, `${label} could not fetch ${images.opsRef} (${lastLine(r.stderr) || `code ${r.code}`}).`);
    } else {
      if (!imagesFile) return `There is no image file for ${version} to load on ${label}.`;
      say(`Loading the images on ${label}…`);
      r = await run(`${cd}docker load -i ${shQuote(imagesFile)}`, { timeoutMs: 30 * MINUTE });
      if (r.code !== 0) return why(r, `The images could not be loaded on ${label} (${lastLine(r.stderr) || `code ${r.code}`}).`);
    }
    return null;
  };

  const writeSettings = async (list) => {
    try { return await setEnv(t, dir, list, { env }); } catch (e) { return { ok: false, problem: e.message }; } // dotenvLine refusals are plain English
  };

  // 0. A newer release arrived mid-setup: the box is not live yet, so move it on before carrying on.
  if (dep.bundleVersion && dep.bundleVersion !== version && !at('delivered')) {
    say(`A newer release (${version}) arrived during the setup of ${label}; putting it in place.`);
    const p = await putInPlace();
    if (p) return partway(p);
    if (!at('configured')) {
      const w = await writeSettings([{ key: 'APP_TAG', value: version }]);
      if (!w.ok) return partway(w.problem);
    }
    if (dep.setup.step === 'started' || dep.setup.step === 'verified') dep = withStep(dep, 'configured', now());
    dep = save({ ...dep, bundleVersion: version });
  }

  // 1. The bundle files and images are on the box.
  if (at('delivered')) {
    if (dep.setup.step === 'new' && (facts?.hasEnv || facts?.hasCompose)) return stopped();
    const p = await putInPlace();
    if (p) return partway(p);
    dep = { ...dep, bundleVersion: version };
    finish('delivered');
  }

  // 2. ops init makes .env on the box. Never over an existing .env (plan Ruling 7).
  if (at('initialised')) {
    const checked = checkedInitArgs(dep, brief);
    if (checked.problem) return partway(checked.problem);
    let r = await run(`${cd}[ ! -e .env ]`);
    if (r.unreachable) return partway(sshProblem(t, r));
    if (r.code !== 0) return dep.setup.step === 'delivered' ? { outcome: 'stopped', text: interruptedInit(dir, label, dep), dep } : stopped();
    say(`Making the settings on ${label} with ops init…`);
    const cfg = registry ? 'DOCKER_CONFIG="$PWD/.docker" ' : '';
    r = await run(`${cd}${cfg}docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/out" ${shQuote(images.opsRef)} ${checked.args.map(shQuote).join(' ')}`,
      { timeoutMs: 10 * MINUTE });
    // Its checklist (on stderr) is not printed: Conductor does each item itself.
    if (r.code !== 0) return partway(why(r, `ops init did not work on the box: ${firstLine(r.stderr) || `code ${r.code}`}.`));
    finish('initialised');
  }

  // 3. The backup password is shown once, and confirmed saved. Conductor keeps no copy.
  if (at('password-saved')) {
    if (!ask.isTTY) return partway('The backup password has to be shown to you once, and there is no terminal. Run the ship in a terminal.');
    let password;
    try { password = await readBackupPassword(t, dir, { env }); } catch (e) { return partway(e.message); }
    if (password === null) return partway('The new settings on the box have no BACKUP_PASSWORD.');
    ask.sayOnce(passwordBlock(brief.client, dep.name, password));
    password = null;
    const answer = await ask.text('Type saved when it is in your password manager',
      { check: (a) => (a === 'saved' ? null : 'Type saved, or press Ctrl-C to stop (it will be shown again next time).') });
    if (answer === null) return partway('Stopped before the backup password was confirmed.');
    finish('password-saved');
  }

  // 4. What ops init's checklist asks for goes into .env, through standard input.
  if (at('configured')) {
    if (!settings) throw new Error('runFirstSetup needs the settings before the configured step');
    const w = await writeSettings([...baseSettings(dep, version), ...settings.settings]);
    if (!w.ok) return partway(w.problem);
    dep = { ...dep, alerts: settings.alerts };
    finish('configured');
  }

  // 5. Start it.
  if (at('started')) {
    say(`Starting the app on ${label}…`);
    const r = await run(composeCmd(dep, 'up -d'), { timeoutMs: 10 * MINUTE });
    if (r.code !== 0) {
      return partway(why(r, `The box could not start the app (${lastLine(`${r.stdout}\n${r.stderr}`) || `code ${r.code}`}). On the box, docker compose ps and docker compose logs --tail 100 show why.`));
    }
    finish('started');
  }

  // 6. The app answers on the new version, the first backup and restore test work, and every check passes.
  if (at('verified')) {
    say(`Waiting for the app on ${label} to report ${version}…`);
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      const v = await probeVersion(t, dep, { env });
      if (v.unreachable) return partway(v.problem);
      if (v.version?.app === version) break;
      if (Date.now() >= deadline) return partway(`The app did not report version ${version} within ${minutes(startTimeoutMs)}.`);
      await sleep(pollMs);
    }
    say(`Taking the first backup on ${label}…`);
    let r = await run(composeCmd(dep, 'run --rm -T ops backup'), { timeoutMs: 60 * MINUTE });
    if (r.code !== 0) {
      return partway(why(r, `The first backup did not work: ${lastLine(`${r.stdout}\n${r.stderr}`) || `code ${r.code}`}. RUNBOOK.md on the box, "Backups", lists the reasons.`));
    }
    say(`Testing a restore of that backup on ${label}…`);
    r = await run(composeCmd(dep, 'run --rm -T ops restore-test'), { timeoutMs: 60 * MINUTE });
    if (r.code !== 0) {
      return partway(why(r, `The first restore test did not work: ${lastLine(`${r.stdout}\n${r.stderr}`) || `code ${r.code}`}. RUNBOOK.md on the box, "Backups", lists the reasons.`));
    }
    const status = await probeBox(t, dep, { env });
    if (!status.reachable) return partway(status.problem);
    if (!status.checks) return partway("The box's own checks could not run.");
    if (!status.checks.ok) return partway(`The box's checks do not all pass yet:\n${status.checks.failing.map((f) => `- ${f}`).join('\n')}`);
    // The foundation this release is built on, never the box's /api/version field (Task 5 explains why).
    dep = { ...dep, currentVersion: version, foundation };
    finish('verified');
  }

  // 7. The first admin (optional), then it is installed.
  const notes = [];
  if (await ask.confirm('Create the first admin account now?')) {
    const email = await ask.text('Their email address?', {
      check: (a) => (/^[^\s@\x00-\x1f\x7f-][^\s\x00-\x1f\x7f]*@[^\s@\x00-\x1f\x7f]+$/.test(a) && a.length <= 254 ? null : 'Type an email address, such as jo@acme.co.uk.'),
    });
    const name = email === null ? null : await ask.text('Their full name?', {
      check: (a) => (a.trim() !== '' && a.length <= 120 && !/[\x00-\x1f\x7f]/.test(a) && !a.startsWith('-') ? null : 'Type their name, such as Jo Bloggs.'),
    });
    if (email !== null && name !== null) {
      const r = await run(composeCmd(dep, `run --rm -T app node apps/server/dist/auth/bootstrap-admin.js --email ${shQuote(email)} --name ${shQuote(name)}`),
        { timeoutMs: 5 * MINUTE });
      const link = r.code === 0 ? LINK_RE.exec(String(r.stdout ?? ''))?.[0] : null;
      if (link) {
        rememberSecret(link);
        ask.sayOnce(`Send this link to ${terminalText(name)} yourself (it works for 7 days): ${link}`);
      } else {
        const line = r.unreachable ? sshProblem(t, r).replace(/\.$/, '') : (lastLine(r.stderr) || (r.code === 0 ? 'it printed no link' : `code ${r.code}`));
        notes.push(`The first admin could not be created (${line}). Do it later on the box: see RUNBOOK.md, "Create the first admin".`);
      }
    }
  }
  dep = addHistory(dep, { version, outcome: 'installed', at: now() });
  finish('done');

  const text = [
    `${dep.name} is running ${version} on foundation ${foundation}. The first backup and a test restore both worked, and every check passes.`,
    alertsLine(dep.alerts),
    dep.alerts?.heartbeat ? 'The outside watcher (Uptime Kuma) is set.' : 'There is no outside watcher: nobody will notice if the whole box goes off.',
    ...notes,
  ].join('\n');
  return { outcome: 'installed', text: redact(text), dep };
}
