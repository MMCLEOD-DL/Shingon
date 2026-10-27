// Turns a cut release into what a client box needs, and puts it there (Contract 3, Contract 7 §7.8):
// build the images and bundle on a factory machine acquired with purpose 'ship', copy them box-ward through
// Conductor with SHA-256 checks at both ends, then clean the build machine (its highland/* images) and release it.
// No secret is involved: the registry sign-in on the build machine is the operator's own one-off `docker login`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../../exec.js';
import { redact } from '../../secrets.js';
import { terminalText } from '../brief.js';
import { RUN_ID_RE } from '../ids.js';
import { assertSafe, shQuote } from '../remote.js';
import { remoteRun, remotePipe, sendFile, targetOfMachine, sshProblem } from './remote.js';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SUM_RE = /^[0-9a-f]{64}$/;
const REG_HOST_RE = /^[A-Za-z0-9.-]+(:\d+)?$/; // as Task 1's deployment store: a registry host may carry a port
const REG_NS_RE = /^[a-z0-9][a-z0-9._/-]*$/;
// An image ref, allowing a registry host:port in front (assertSafe('image') does not): no spaces, quotes or leading '-'.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?\/(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$|^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+$/;
const BUNDLE_FILES = ['compose.yaml', 'Caddyfile', '.env.example', 'RUNBOOK.md'];
const SAVE_TIMEOUT_MS = 30 * 60000;
const COPY_TIMEOUT_MS = 60 * 60000;

const qp = (p) => shQuote(assertSafe('path', p));
function assertRef(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.split('/').includes('..')) throw new Error(`unsafe image for a remote command: ${JSON.stringify(ref)}`);
  return ref;
}
const isRef = (ref) => { try { assertRef(ref); return true; } catch { return false; } };
const qi = (i) => shQuote(assertRef(i));
const clean = (s, max = 160) => String(redact(terminalText(s))).trim().slice(0, max).replace(/[.\s]+$/, '');
const lastLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

function checkVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error(`"${version}" is not a release version`);
  return version;
}

export function imageNames({ imageDelivery, registry, slug, version }) {
  checkVersion(version);
  let app = 'highland/app', ops = 'highland/ops';
  if (imageDelivery === 'registry') {
    const host = registry?.host;
    if (typeof host !== 'string' || !REG_HOST_RE.test(host) || host.startsWith('-')) throw new Error(`unsafe registry host: ${JSON.stringify(host)}`);
    const namespace = registry?.namespace ?? `highland-${slug}`;
    if (typeof namespace !== 'string' || !REG_NS_RE.test(namespace) || namespace.split('/').includes('..')) throw new Error(`unsafe registry namespace: ${JSON.stringify(namespace)}`);
    app = `${host}/${namespace}/app`;
    ops = `${host}/${namespace}/ops`;
  }
  const names = { app, ops, appRef: `${app}:${version}`, opsRef: `${ops}:${version}` };
  assertRef(names.appRef);
  assertRef(names.opsRef);
  return names;
}

// sha256sum output: "<64 hex>  <path>" per line.
function sumsOf(stdout) {
  const out = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1]);
  }
  return out;
}

export async function buildOnMachine({ provider, slug, runId, appDir, release, dep, say = () => {}, env = process.env, buildTimeoutMs = 60 * 60000 }) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error(`"${runId}" is not a valid run id`);
  assertSafe('slug', slug);
  const version = checkVersion(release?.version);
  const { sha, tag } = release;
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error(`"${sha}" is not a release commit`);
  if (tag !== `v${version}`) throw new Error(`"${tag}" is not the tag for ${version}`);
  const images = imageNames({ imageDelivery: dep.imageDelivery, registry: dep.registry, slug, version });
  const tarDelivery = dep.imageDelivery !== 'registry';

  let machine;
  try {
    machine = await provider.acquire({ purpose: 'ship', projectSlug: slug, runId });
  } catch (e) {
    return { ok: false, problem: `No build machine was available: ${clean(e?.message ?? e, 300)}.` };
  }

  const target = targetOfMachine(machine);
  const workDir = machine.runDir;
  const built = { ok: true, problem: null, machine, target, workDir, version, arch: null, images, imagesFile: null, bundleFile: null };
  try {
    return await buildSteps({ built, appDir, release, tarDelivery, say, env, buildTimeoutMs });
  } catch (e) {
    await cleanupBuild(built, { env });
    return { ok: false, problem: `The build on the build machine stopped unexpectedly (${clean(e?.message ?? e) || 'no reason given'}).` };
  }
}

async function buildSteps({ built, appDir, release: { sha, tag, version }, tarDelivery, say, env, buildTimeoutMs }) {
  const { target, workDir, images } = built;
  const fail = async (problem) => {
    await cleanupBuild(built, { env });
    return { ok: false, problem };
  };
  const failedWhile = (step, why) => fail(`The build on the build machine failed while ${step} (${why}).`);
  const run = async (step, command, timeoutMs = 120000) => {
    say(`${step[0].toUpperCase()}${step.slice(1)}…`);
    const r = await remoteRun(target, command, { env, timeoutMs });
    if (r.code === 0) return { r, problem: null };
    const why = r.timedOut ? `it took longer than ${Math.round(timeoutMs / 60000)} minutes`
      : (clean(lastLine(r.stderr)) || clean(lastLine(r.stdout)) || `code ${r.code}`);
    return { r, problem: await failedWhile(step, why) };
  };

  try { assertSafe('path', workDir); } catch {
    return fail('The build machine gave Conductor a folder it will not use, so nothing was built.');
  }
  const w = shQuote(workDir);
  const bundlePath = `${workDir}/src/dist/highland-bundle-${version}.tar.gz`;
  const imagesPath = `${workDir}/images-${version}.tar`;

  let s = await run('checking the build machine',
    'uname -m; for t in docker node npm git sha256sum; do command -v "$t" >/dev/null 2>&1 || echo "missing=$t"; done');
  if (s.problem) return s.problem;
  const lines = String(s.r.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  const missing = lines.map((l) => /^missing=([\w.-]{1,20})$/.exec(l)?.[1]).filter(Boolean);
  if (missing.length) return fail(missing.map((t) => `${t} is missing on the build machine.`).join(' '));
  built.arch = /^[A-Za-z0-9_.-]{1,40}$/.test(lines[0] ?? '') ? lines[0] : null;

  s = await run('preparing a folder', `mkdir -p ${w}`);
  if (s.problem) return s.problem;

  say('Sending the app…');
  const tmp = mkdtempSync(path.join(tmpdir(), 'conductor-ship-'));
  try {
    const local = path.join(tmp, 'app.bundle');
    const g = await runCommand({ cmd: 'git', args: ['-C', appDir, 'bundle', 'create', local, tag], env, timeoutMs: 300000 });
    if (g.code !== 0) return failedWhile('sending the app', clean(lastLine(g.stderr)) || `git code ${g.code}`);
    const sent = await sendFile(local, { target, command: `cat > ${qp(`${workDir}/app.bundle`)}` }, { env, timeoutMs: COPY_TIMEOUT_MS });
    if (!sent.ok) return failedWhile('sending the app', clean(sent.why));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  s = await run('unpacking the app',
    `cd ${w} && git clone -q --branch ${shQuote(tag)} app.bundle src && test "$(git -C src rev-parse HEAD)" = ${shQuote(sha)}`);
  if (s.problem) return s.problem;

  s = await run('building the images', `cd ${qp(`${workDir}/src`)} && npm ci --no-audit --no-fund && npm run images && npm run bundle`, buildTimeoutMs);
  if (s.problem) return s.problem;

  const local = { app: `highland/app:${version}`, ops: `highland/ops:${version}` };
  const step = tarDelivery ? 'saving the images' : 'pushing the images';
  s = tarDelivery
    ? await run(step, `docker save ${qi(local.app)} ${qi(local.ops)} -o ${qp(imagesPath)} && sha256sum ${qp(imagesPath)} ${qp(bundlePath)}`, SAVE_TIMEOUT_MS)
    : await run(step, `docker tag ${qi(local.app)} ${qi(images.appRef)} && docker tag ${qi(local.ops)} ${qi(images.opsRef)}`
      + ` && docker push ${qi(images.appRef)} && docker push ${qi(images.opsRef)} && sha256sum ${qp(bundlePath)}`, SAVE_TIMEOUT_MS);
  if (s.problem) return s.problem;

  const sums = sumsOf(s.r.stdout);
  if (!sums.get(bundlePath) || (tarDelivery && !sums.get(imagesPath))) return failedWhile(step, 'no checksum came back');
  built.bundleFile = { path: bundlePath, sha256: sums.get(bundlePath) };
  if (tarDelivery) built.imagesFile = { path: imagesPath, sha256: sums.get(imagesPath) };
  return built;
}

export async function deliverToBox({ built, target, dep, version, say = () => {}, env = process.env }) {
  checkVersion(version);
  const label = target.label;
  const dir = assertSafe('path', dep.bundleDir);
  const c = `${dir}/.conductor`;
  const nope = (problem) => ({ ok: false, problem, imagesFile: null });
  const boxProblem = (r, fallback) => (r.unreachable ? sshProblem(target, r) : fallback);

  let r = await remoteRun(target, `mkdir -p ${qp(c)}`, { env });
  if (r.code !== 0) {
    return nope(boxProblem(r, `Conductor could not create ${dir} on ${label}. Create it once by hand on the box: sudo mkdir -p ${dir} && sudo chown ${target.user} ${dir}`));
  }

  const tarDelivery = dep.imageDelivery !== 'registry';
  const files = [{ src: built.bundleFile, final: `${c}/highland-bundle-${version}.tar.gz` }];
  if (tarDelivery) files.push({ src: built.imagesFile, final: `${dir}/images-${version}.tar` });

  for (const { src, final } of files) {
    const name = path.posix.basename(final);
    if (!src || !SUM_RE.test(src.sha256 ?? '')) return nope(`Conductor has no checksum for ${name}, so nothing was copied to ${label}.`);
    const part = `${final}.part`;
    r = await remoteRun(target, `sha256sum ${qp(final)} 2>/dev/null`, { env });
    if (r.code === 0 && String(r.stdout).trim().split(/\s+/)[0] === src.sha256) {
      say(`${name} is already on ${label}.`);
      continue;
    }
    say(`Copying ${name} to ${label}…`);
    const copied = await remotePipe({ target: built.target, command: `cat ${qp(src.path)}` }, { target, command: `cat > ${qp(part)}` },
      { env, timeoutMs: COPY_TIMEOUT_MS });
    if (!copied.ok) return nope(`The copy of ${name} to ${label} did not finish: ${clean(copied.why)}. Run the ship again.`);
    r = await remoteRun(target, `sha256sum ${qp(part)}`, { env });
    if (r.code === 0 && String(r.stdout).trim().split(/\s+/)[0] === src.sha256) {
      r = await remoteRun(target, `mv ${qp(part)} ${qp(final)}`, { env });
      if (r.code !== 0) return nope(sshProblem(target, r));
      continue;
    }
    if (r.code !== 0) return nope(sshProblem(target, r)); // could not check the copy: fail closed, never load it
    await remoteRun(target, `rm -f ${qp(part)}`, { env });
    return nope(`The copy of ${name} to ${label} arrived damaged (its checksum did not match), so nothing was loaded. Run the ship again.`);
  }

  const ref = `${c}/bundle-${version}`;
  const incomplete = `The bundle for ${version} is incomplete.`;
  r = await remoteRun(target, `rm -rf ${qp(ref)} && mkdir -p ${qp(ref)} && tar -xzf ${qp(`${c}/highland-bundle-${version}.tar.gz`)} -C ${qp(ref)}`, { env });
  if (r.code !== 0) return nope(boxProblem(r, incomplete));
  r = await remoteRun(target, `ls -A ${qp(ref)}`, { env });
  if (r.code !== 0) return nope(boxProblem(r, incomplete));
  const present = new Set(String(r.stdout).split('\n').map((l) => l.trim()));
  if (!BUNDLE_FILES.every((f) => present.has(f))) return nope(incomplete);

  return { ok: true, problem: null, imagesFile: tarDelivery ? `images-${version}.tar` : null };
}

// Never throws. Removes the images this build made (the foundation's own names, plus registry tags), so the
// foundation smoke can run on the machine afterwards (Contract 7 §7.8), then releases the machine.
export async function cleanupBuild(built, { env = process.env } = {}) {
  try {
    const v = built?.version;
    const names = [`highland/app:${v}`, `highland/ops:${v}`];
    for (const ref of [built?.images?.appRef, built?.images?.opsRef]) if (ref && !names.includes(ref)) names.push(ref);
    const safe = names.filter(isRef);
    if (built?.target && safe.length) await remoteRun(built.target, `docker rmi ${safe.map(shQuote).join(' ')}`, { env });
  } catch { /* an image that was never built, or a machine that is gone, is not a problem */ }
  try { await built?.machine?.release?.(); } catch { /* Plan 8's sweep frees what release could not */ }
}
