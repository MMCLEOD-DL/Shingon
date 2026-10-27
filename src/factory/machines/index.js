// Machine providers for previews and council deploy tests (Contract 3). `static` hands out machines the operator runs;
// `proxmox` clones LXC containers inside the factory's own pool.
import { createSsh } from '../ssh.js';
import { addScrubEnv } from '../../secrets.js';
import { StaticProvider } from './static.js';
import { ProxmoxProvider } from './proxmox.js';
import { createPveClient } from './pveApi.js';

export class MachineError extends Error {
  // code: busy | unreachable | cap | config | failed. The message is the plain sentence shown to the operator.
  constructor(code, message) {
    super(message);
    this.name = 'MachineError';
    this.code = code;
  }
}

export const runImages = (slug, runId) => [`hf-preview/${slug}-app:${runId}`, `hf-preview/${slug}-ops:${runId}`];

export function whenText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute} ${parts.day} ${parts.month}`;
}

export function getMachineProvider(factory, { ssh, pve = null, now = () => new Date(), env = process.env } = {}) {
  const m = factory?.machines;
  if (m?.provider === 'proxmox') {
    const cfg = m.proxmox;
    addScrubEnv(cfg.tokenEnv);
    const secret = env[cfg.tokenEnv];
    if (!secret) throw new MachineError('config', `The Proxmox API token is not set. Put its secret in the environment variable ${cfg.tokenEnv} (never in the config file).`);
    let client = pve;
    if (!client) {
      try { client = createPveClient({ apiUrl: cfg.apiUrl, tokenId: cfg.tokenId, secret, caFile: cfg.caFile }); } catch (e) { throw new MachineError('config', e.message); }
    }
    return new ProxmoxProvider({ cfg, pve: client, ssh: ssh ?? createSsh({ sshBin: m.sshBin, scpBin: m.scpBin }), now });
  }
  const hosts = m?.static?.hosts ?? [];
  if (hosts.length === 0) {
    throw new MachineError('config', 'No factory machines are set up. Add one under factory.machines.static.hosts in the config (for example CT 111, hf-build at 192.168.1.111).');
  }
  return new StaticProvider({ hosts, ssh: ssh ?? createSsh({ sshBin: m.sshBin, scpBin: m.scpBin }), now });
}
