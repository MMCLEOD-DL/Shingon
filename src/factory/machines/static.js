// The static provider: machines the operator already runs. One use per host at a time, guarded by a lock folder on the host.
import { assertSafe, shQuote, lockScript, unlockScript, readLockScript, teardownScript, sweepScript, parseMarker, ownerJson } from '../remote.js';
import { unreachable } from '../ssh.js';
import { composeProjectOf, RUN_ID_RE, SLUG_RE } from '../ids.js';
import { MachineError, runImages, whenText } from './index.js';

const PURPOSES = ['preview', 'council', 'smoke', 'ship'];

// Why an ssh call failed, in a few plain words: the text after the last ": " of the first stderr line.
function reasonOf(r) {
  const line = String(r.stderr ?? '').split('\n').find((l) => l.trim()) ?? '';
  const tail = line.split(': ').pop().trim().replace(/[^\x20-\x7e]/g, '');
  return (tail || 'no answer').slice(0, 120);
}

// Only clears a lock that has no owner.json (a crash between mkdir and the write) and is old enough.
function clearOwnerlessScript({ root, olderThanSec }) {
  assertSafe('path', root);
  if (!Number.isInteger(olderThanSec) || olderThanSec < 0) throw new Error('unsafe olderThanSec for a remote command');
  return `set -euo pipefail
ROOT=${shQuote(root)}
if [ -d "$ROOT/lock" ] && [ ! -e "$ROOT/lock/owner.json" ] && [ $(( $(date +%s) - $(stat -c %Y "$ROOT/lock") )) -ge ${olderThanSec} ]; then rmdir "$ROOT/lock" 2>/dev/null && echo HF-CLEARED || echo HF-KEPT; else echo HF-KEPT; fi
`;
}

function parseOwner(rest) {
  if (!rest) return null;
  try {
    const o = JSON.parse(rest);
    if (o && typeof o === 'object' && RUN_ID_RE.test(o.run) && SLUG_RE.test(o.project) && PURPOSES.includes(o.purpose) && typeof o.createdAt === 'string') return o;
  } catch { /* unreadable: treated as no owner */ }
  return null;
}

export class StaticProvider {
  constructor({ hosts, ssh, now = () => new Date() }) {
    this.hosts = hosts;
    this.ssh = ssh;
    this.now = now;
    this.notes = [];
    this.provider = 'static';
  }

  checkHost(host) {
    try {
      assertSafe('host', host.host); assertSafe('user', host.user); assertSafe('path', host.workRoot);
    } catch {
      throw new MachineError('config', `The factory machine ${host.name} has a host, user or work folder that is not safe to use. Fix factory.machines.static.hosts in the config.`);
    }
  }

  probe(host) {
    return { host: host.host, ssh: { user: host.user, keyPath: host.keyPath, knownHostsFile: null, hostKeyPolicy: 'yes' } };
  }

  unreachableError(host, r) {
    return new MachineError('unreachable', `Conductor could not reach ${host.name} (${host.host}) over SSH: ${reasonOf(r)}. Check the machine is on and that "ssh ${host.user}@${host.host} true" works from this computer without a password.`);
  }

  machineFor(host, labels) {
    const composeProject = composeProjectOf(labels.project, labels.run);
    const machine = {
      id: host.id, name: host.name, host: host.host,
      ssh: { user: host.user, keyPath: host.keyPath, knownHostsFile: null, hostKeyPolicy: 'yes' },
      labels, provider: 'static', composeProject, runDir: `${host.workRoot}/runs/${composeProject}`, previewPort: host.previewPort,
      release: () => this.release(host, labels, composeProject),
    };
    return machine;
  }

  async release(host, labels, composeProject) {
    const m = this.probe(host);
    const t = await this.ssh.exec(m, teardownScript({ root: host.workRoot, project: composeProject, images: runImages(labels.project, labels.run) }));
    if (unreachable(t)) throw this.unreachableError(host, t);
    const tm = parseMarker(t.stdout);
    if (tm.marker === 'HF-LEFTOVERS') {
      const n = /^\d+/.exec(tm.rest)?.[0] ?? 'some';
      throw new MachineError('failed', `Conductor could not fully clean up ${composeProject} on ${host.name} (${n} containers left). The machine stays locked so nothing else uses it; run "conductor machines sweep", or remove them by hand.`);
    }
    if (tm.marker !== 'HF-TORN-DOWN') throw new MachineError('failed', `${host.name} gave an unexpected answer while cleaning up ${composeProject}. The machine stays locked; run "conductor machines sweep" to retry.`);
    const u = await this.ssh.exec(m, unlockScript({ root: host.workRoot, runId: labels.run }));
    if (unreachable(u)) throw this.unreachableError(host, u);
    const um = parseMarker(u.stdout).marker;
    if (!['HF-UNLOCKED', 'HF-NO-LOCK', 'HF-NOT-OURS'].includes(um)) throw new MachineError('failed', `${host.name} gave an unexpected answer while releasing its lock. Run "conductor machines sweep" to retry.`);
  }

  async acquire({ purpose, projectSlug, runId }) {
    assertSafe('purpose', purpose); assertSafe('slug', projectSlug); assertSafe('runId', runId);
    const labels = { factory: 'hf', project: projectSlug, run: runId, purpose, createdAt: this.now().toISOString() };
    const down = []; const busy = []; const odd = [];
    for (const host of this.hosts) {
      this.checkHost(host);
      const r = await this.ssh.exec(this.probe(host), lockScript({ root: host.workRoot, owner: ownerJson(labels) }));
      if (unreachable(r)) { down.push({ host, r }); continue; }
      const { marker, rest } = parseMarker(r.stdout);
      if (marker === 'HF-LOCKED') return this.machineFor(host, labels);
      if (marker === 'HF-BUSY') busy.push({ host, owner: parseOwner(rest) });
      else odd.push(host);
    }
    if (busy.length === 0 && odd.length === 0 && down.length > 0) {
      throw new MachineError('unreachable', down.map(({ host, r }) => this.unreachableError(host, r).message).join(' '));
    }
    if (busy.length === 0) {
      const names = odd.map((h) => h.name).join(', ');
      throw new MachineError('failed', `${names || 'A factory machine'} gave an unexpected answer when Conductor tried to take it. Check it with "ssh <user>@<host> true" and try again.`);
    }
    const holders = []; const hints = [];
    for (const { host, owner } of busy) {
      if (!owner) {
        holders.push(`${host.name}'s lock has no owner (a run crashed while taking it)`);
        hints.push(`To clear it, remove ${host.workRoot}/lock on ${host.name} (ssh ${host.user}@${host.host} rmdir ${host.workRoot}/lock), or run "conductor machines sweep" once it is old enough.`);
        continue;
      }
      holders.push(`${host.name} is running a ${owner.purpose} for ${owner.project} (since ${whenText(owner.createdAt)})`);
      hints.push(owner.purpose === 'preview' ? `Stop it with: conductor preview ${owner.project} --stop` : 'It is cleaned up when that run ends; "conductor machines sweep" clears one left over from a crash.');
    }
    const extra = down.length ? ` (${down.map((d) => d.host.name).join(', ')} could not be reached.)` : '';
    throw new MachineError('busy', `Every factory machine is in use: ${holders.join('; ')}.${extra} ${[...new Set(hints)].join(' ')}`);
  }

  async list() {
    this.notes = [];
    const out = [];
    for (const host of this.hosts) {
      this.checkHost(host);
      const r = await this.ssh.exec(this.probe(host), readLockScript({ root: host.workRoot }));
      if (unreachable(r)) { this.notes.push(`${host.name} (${host.host}) could not be reached: ${reasonOf(r)}.`); continue; }
      const { marker, rest } = parseMarker(r.stdout);
      if (marker !== 'HF-HELD') continue;
      const o = parseOwner(rest);
      if (!o) { this.notes.push(`${host.name}'s lock has no owner (a run crashed while taking it); remove ${host.workRoot}/lock to clear it.`); continue; }
      out.push(this.machineFor(host, { factory: 'hf', project: o.project, run: o.run, purpose: o.purpose, createdAt: o.createdAt }));
    }
    return out;
  }

  async sweep({ olderThanMs, keep = [] }) {
    this.notes = [];
    let total = 0;
    for (const host of this.hosts) {
      this.checkHost(host);
      const probe = this.probe(host);
      const r = await this.ssh.exec(probe, readLockScript({ root: host.workRoot }));
      if (unreachable(r)) { this.notes.push(`${host.name} (${host.host}) could not be reached: ${reasonOf(r)}.`); continue; }
      const { marker, rest } = parseMarker(r.stdout);
      const keepRuns = [...keep];
      if (marker === 'HF-HELD') {
        const o = parseOwner(rest);
        if (!o) {
          const c = await this.ssh.exec(probe, clearOwnerlessScript({ root: host.workRoot, olderThanSec: Math.floor(olderThanMs / 1000) }));
          if (parseMarker(c.stdout).marker === 'HF-CLEARED') total += 1;
          else this.notes.push(`${host.name}'s lock has no owner (a run crashed while taking it); remove ${host.workRoot}/lock if it stays.`);
        } else if (!keep.includes(o.run) && this.now().getTime() - new Date(o.createdAt).getTime() >= olderThanMs) {
          try {
            await this.machineFor(host, { factory: 'hf', project: o.project, run: o.run, purpose: o.purpose, createdAt: o.createdAt }).release();
            total += 1;
          } catch (e) {
            this.notes.push(e.message);
            keepRuns.push(o.run);
          }
        } else keepRuns.push(o.run);
      }
      const s = await this.ssh.exec(probe, sweepScript({ root: host.workRoot, olderThanSec: Math.floor(olderThanMs / 1000), keepRuns }));
      if (unreachable(s)) { this.notes.push(`${host.name} (${host.host}) stopped answering during the sweep.`); continue; }
      total += String(s.stdout ?? '').split('\n').filter((l) => l.startsWith('HF-SWEPT ')).length;
    }
    return total;
  }
}
