// The proxmox provider: LXC containers cloned from a Docker-ready template, only inside the factory's own pool,
// VMID range and resource cap (Contract 3, index Ruling 11). Every container is tagged with the project and run,
// and nothing is ever stopped or deleted unless a fresh read shows it is in the pool, in the range, not the
// template, and tagged hf-factory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafe } from '../remote.js';
import { composeProjectOf, SLUG_RE, RUN_ID_RE } from '../ids.js';
import { MachineError } from './index.js';

const PURPOSES = ['preview', 'council', 'smoke', 'ship'];
const FACTORY_TAG = 'hf-factory';
const ADDRESS_TRIES = 60; // every 2 s: 120 s
const SSH_TRIES = 40; // every 3 s: 120 s

// hf-factory;hf-p-<slug>;hf-r-<runId>;hf-u-<purpose>;hf-t-<unix seconds>
export function tagsFor({ project, run, purpose, createdAt }) {
  const secs = Math.floor(new Date(createdAt).getTime() / 1000);
  return [FACTORY_TAG, `hf-p-${project}`, `hf-r-${run}`, `hf-u-${purpose}`, `hf-t-${secs}`].join(';');
}

const tagList = (tags) => String(tags ?? '').split(/[;,\s]+/).filter(Boolean);
const hasFactoryTag = (tags) => tagList(tags).includes(FACTORY_TAG);

// The labels a container's tags carry, or null when it is not a factory container or a label is missing or malformed.
export function labelsFromTags(tags) {
  const list = tagList(tags);
  if (!list.includes(FACTORY_TAG)) return null;
  const pick = (prefix) => list.find((t) => t.startsWith(prefix))?.slice(prefix.length);
  const project = pick('hf-p-'); const run = pick('hf-r-'); const purpose = pick('hf-u-'); const t = pick('hf-t-');
  if (!SLUG_RE.test(project ?? '') || !RUN_ID_RE.test(run ?? '') || !PURPOSES.includes(purpose) || !/^\d{1,12}$/.test(t ?? '')) return null;
  return { factory: 'hf', project, run, purpose, createdAt: new Date(Number(t) * 1000).toISOString() };
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

export class ProxmoxProvider {
  constructor({ cfg, pve, ssh, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), knownHostsDir = path.join(os.homedir(), '.conductor', 'machines') }) {
    this.cfg = cfg;
    this.pve = pve;
    this.ssh = ssh;
    this.now = now;
    this.sleep = sleep;
    this.knownHostsDir = knownHostsDir;
    this.notes = [];
    this.kind = 'proxmox';
    this.provider = 'proxmox';
    this.nodePath = `/nodes/${encodeURIComponent(cfg.node)}`;
  }

  inRange(vmid) {
    const [lo, hi] = this.cfg.vmidRange;
    return Number.isInteger(vmid) && vmid >= lo && vmid <= hi;
  }

  // Ruling 11: the only containers the provider may ever stop or delete.
  isOurs(r) {
    return r?.type === 'lxc' && r.node === this.cfg.node && r.pool === this.cfg.pool && Number(r.vmid) !== this.cfg.template
      && this.inRange(Number(r.vmid)) && hasFactoryTag(r.tags);
  }

  async resources() {
    const list = await this.pve.get('/cluster/resources?type=vm');
    return Array.isArray(list) ? list : [];
  }

  // Factory containers, noting the pool's containers that carry no (readable) factory label.
  ours(resources) {
    const out = [];
    for (const r of resources) {
      if (r?.type !== 'lxc' || r.pool !== this.cfg.pool || Number(r.vmid) === this.cfg.template) continue;
      if (!hasFactoryTag(r.tags)) { this.notes.push(`Container ${r.vmid} is in the factory's pool but has no factory label, so it was left alone.`); continue; }
      if (!this.isOurs(r)) { this.notes.push(`Container ${r.vmid} has the factory label but is outside the factory's number range, so it was left alone.`); continue; }
      out.push(r);
    }
    return out;
  }

  knownHostsFile(vmid) { return path.join(this.knownHostsDir, `known_hosts-${vmid}`); }

  forgetHostKey(vmid) { fs.rmSync(this.knownHostsFile(vmid), { force: true }); }

  machineFor(vmid, labels, host) {
    const composeProject = composeProjectOf(labels.project, labels.run);
    return {
      id: String(vmid), vmid, name: `hf-${labels.project}-${vmid}`, host,
      ssh: { user: this.cfg.user, keyPath: this.cfg.keyPath, knownHostsFile: this.knownHostsFile(vmid), hostKeyPolicy: 'accept-new' },
      labels, provider: 'proxmox', composeProject, runDir: `${this.cfg.workRoot}/runs/${composeProject}`, previewPort: this.cfg.previewPort,
      release: () => this.destroy(vmid),
    };
  }

  // A fresh read of one container: null when it is gone; a refusal unless it is one of ours.
  async guarded(vmid) {
    const r = (await this.resources()).find((x) => Number(x.vmid) === vmid);
    if (!r) return null;
    if (!this.isOurs(r)) {
      throw new MachineError('failed', `Conductor refused to delete container ${vmid}: it is not one of the factory's own machines (outside its pool, its number range or its label). Nothing was changed.`);
    }
    return r;
  }

  // The guarded delete. Returns whether a container was removed.
  async removeContainer(vmid) {
    if (!Number.isInteger(vmid)) throw new MachineError('failed', `Conductor refused to delete container ${vmid}: it is not one of the factory's own machines (outside its pool, its number range or its label). Nothing was changed.`);
    let r = await this.guarded(vmid);
    if (!r) { this.forgetHostKey(vmid); return false; }
    if (r.status !== 'stopped') {
      const upid = await this.pve.post(`${this.nodePath}/lxc/${vmid}/status/stop`);
      await this.pve.waitTask(this.cfg.node, upid);
      r = await this.guarded(vmid);
      if (!r) { this.forgetHostKey(vmid); return false; }
    }
    const upid = await this.pve.del(`${this.nodePath}/lxc/${vmid}?purge=1&destroy-unreferenced-disks=1`);
    await this.pve.waitTask(this.cfg.node, upid);
    this.forgetHostKey(vmid);
    return true;
  }

  async destroy(vmid) {
    try {
      await this.removeContainer(vmid);
    } catch (e) {
      if (e instanceof MachineError) throw e;
      throw new MachineError('failed', `Conductor could not delete container ${vmid} on Proxmox: ${sentence(firstLine(e))}`);
    }
  }

  async address(vmid) {
    const list = await this.pve.get(`${this.nodePath}/lxc/${vmid}/interfaces`);
    for (const i of Array.isArray(list) ? list : []) {
      const ip = String(i?.inet ?? '').split('/')[0];
      if (i?.name !== 'lo' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith('127.')) return ip;
    }
    return null;
  }

  async acquire({ purpose, projectSlug, runId }) {
    assertSafe('purpose', purpose); assertSafe('slug', projectSlug); assertSafe('runId', runId);
    const labels = { factory: 'hf', project: projectSlug, run: runId, purpose, createdAt: this.now().toISOString() };
    const cfg = this.cfg;
    this.notes = [];
    let all;
    try { all = await this.resources(); } catch (e) {
      throw new MachineError('failed', `Conductor could not prepare a machine on Proxmox: ${sentence(firstLine(e))}`);
    }
    const mine = this.ours(all);
    if (mine.length >= cfg.maxContainers) {
      const what = mine.map((r) => { const l = labelsFromTags(r.tags); return l ? `${l.project} ${l.purpose}` : `container ${r.vmid}`; }).join(', ');
      throw new MachineError('cap', `The factory already has ${mine.length} machines (its limit): ${what}. Stop a preview, or run "conductor machines sweep" to clear ones left over from crashes.`);
    }
    const usedMb = mine.reduce((n, r) => n + Math.round((Number(r.maxmem) || 0) / 1048576), 0);
    if (usedMb + cfg.memoryMb > cfg.maxMemoryMb) {
      throw new MachineError('cap', `Another machine would take the factory over its memory limit (${cfg.maxMemoryMb} MB).`);
    }
    const taken = new Set(all.map((r) => Number(r.vmid)));
    const [lo, hi] = cfg.vmidRange;
    const free = [];
    for (let v = lo; v <= hi; v += 1) if (!taken.has(v)) free.push(v);
    if (free.length === 0) throw new MachineError('cap', `There are no free machine numbers left in ${lo}–${hi}.`);

    let vmid = null; let upid = null; let lastErr = null;
    for (const candidate of free.slice(0, 3)) {
      try {
        upid = await this.pve.post(`${this.nodePath}/lxc/${cfg.template}/clone`, {
          newid: candidate, hostname: `hf-${projectSlug}`.slice(0, 50) + `-${candidate}`, pool: cfg.pool, full: cfg.fullClone ? 1 : 0,
          description: `Made by Conductor for the ${purpose} of ${projectSlug} (run ${runId}). Safe to delete.`,
        });
        vmid = candidate;
        break;
      } catch (e) {
        lastErr = e;
        if (!/already exists/i.test(e?.message ?? '')) break;
      }
    }
    if (vmid === null) throw new MachineError('failed', `Conductor could not prepare a machine on Proxmox: ${sentence(firstLine(lastErr))}`);

    // From here the container may exist: every failure removes it (through the guard) before throwing.
    try {
      await this.pve.waitTask(cfg.node, upid);
      await this.pve.put(`${this.nodePath}/lxc/${vmid}/config`, { tags: tagsFor(labels), cores: cfg.cores, memory: cfg.memoryMb, onboot: 0 });
      await this.pve.waitTask(cfg.node, await this.pve.post(`${this.nodePath}/lxc/${vmid}/status/start`));
      let host = null;
      for (let i = 0; i < ADDRESS_TRIES && !host; i += 1) {
        try { host = await this.address(vmid); } catch { host = null; }
        if (!host) await this.sleep(2000);
      }
      if (!host) throw new Error(`The new container did not get a network address within ${(ADDRESS_TRIES * 2)} seconds.`);
      fs.mkdirSync(this.knownHostsDir, { recursive: true, mode: 0o700 });
      this.forgetHostKey(vmid);
      const machine = this.machineFor(vmid, labels, host);
      let ready = false;
      for (let i = 0; i < SSH_TRIES && !ready; i += 1) {
        try { ready = (await this.ssh.exec(machine, 'true', { timeoutMs: 30000 }))?.code === 0; } catch { ready = false; }
        if (!ready) await this.sleep(3000);
      }
      if (!ready) throw new Error(`The new container did not answer over SSH within ${SSH_TRIES * 3} seconds.`);
      return machine;
    } catch (e) {
      const reason = sentence(firstLine(e));
      let after;
      try {
        after = (await this.removeContainer(vmid)) ? `It removed the half-made container (${vmid}).` : 'Nothing was left behind.';
      } catch (d) {
        after = `It could not remove the half-made container (${vmid}): ${sentence(firstLine(d))} Remove it by hand on Proxmox.`;
      }
      throw new MachineError('failed', `Conductor could not prepare a machine on Proxmox: ${reason} ${after}`);
    }
  }

  async list() {
    this.notes = [];
    const out = [];
    for (const r of this.ours(await this.resources())) {
      const labels = labelsFromTags(r.tags);
      if (!labels) { this.notes.push(`Container ${r.vmid} has the factory label but its other labels cannot be read, so it was left alone.`); continue; }
      let host = null;
      if (r.status === 'running') { try { host = await this.address(Number(r.vmid)); } catch { host = null; } }
      out.push(this.machineFor(Number(r.vmid), labels, host));
    }
    return out.sort((a, b) => a.vmid - b.vmid);
  }

  async sweep({ olderThanMs, keep = [] }) {
    this.notes = [];
    let total = 0;
    const nowMs = this.now().getTime();
    for (const r of this.ours(await this.resources())) {
      const labels = labelsFromTags(r.tags);
      if (!labels) { this.notes.push(`Container ${r.vmid} has the factory label but its other labels cannot be read, so it was left alone.`); continue; }
      if (keep.includes(labels.run) || nowMs - new Date(labels.createdAt).getTime() < olderThanMs) continue;
      try {
        await this.destroy(Number(r.vmid));
        total += 1;
      } catch (e) { this.notes.push(e.message); }
    }
    return total;
  }
}
