// In-memory stub of the few Proxmox VE API calls the proxmox provider uses (127.0.0.1 only).
import http from 'node:http';
import { randomBytes } from 'node:crypto';

export async function startPveStub({ token = 'conductor@pve!factory=s3cret-token-value', node = 'ms01', resources = [], failOn = {} } = {}) {
  const state = { resources: resources.map((r) => ({ ...r })), tasks: new Map(), config: new Map() };
  const requests = [];
  const hex = (n) => randomBytes(n).toString('hex').toUpperCase();
  const newTask = (kind, vmid, failText) => {
    const upid = `UPID:${node}:${hex(4)}:${hex(4)}:${hex(4)}:${kind}:${vmid}:conductor@pve!factory:`;
    state.tasks.set(upid, failText ? { status: 'stopped', exitstatus: failText } : { status: 'stopped', exitstatus: 'OK' });
    return upid;
  };
  const find = (id) => state.resources.find((r) => String(r.vmid) === String(id));

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, data, message) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(message === undefined ? { data } : { data: null, message }));
      };
      const u = new URL(req.url, 'http://127.0.0.1');
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const query = Object.fromEntries(u.searchParams);
      const prefix = '/api2/json';
      const path = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;
      requests.push({ method: req.method, path: u.pathname, search: u.search, query, form });
      if (req.headers.authorization !== `PVEAPIToken=${token}`) return send(401, null, 'no ticket');
      let m;
      const M = req.method;
      if (M === 'GET' && path === '/cluster/resources') {
        // type=vm: guests only (lxc and qemu), as Proxmox answers; other types (storage, node) are left out.
        const list = query.type === 'vm' ? state.resources.filter((r) => r.type === 'lxc' || r.type === 'qemu')
          : query.type ? state.resources.filter((r) => r.type === query.type) : state.resources;
        return send(200, list);
      }
      if ((m = path.match(/^\/nodes\/([^/]+)\/tasks\/([^/]+)\/status$/)) && M === 'GET') {
        const t = state.tasks.get(decodeURIComponent(m[2]));
        return t ? send(200, t) : send(500, null, 'no such task');
      }
      if ((m = path.match(/^\/nodes\/([^/]+)\/lxc\/(\d+)\/clone$/)) && M === 'POST') {
        const src = find(m[2]);
        if (!src) return send(500, null, `Configuration file 'nodes/${m[1]}/lxc/${m[2]}.conf' does not exist`);
        if (!form.newid || !form.hostname || !form.pool) return send(400, null, 'Parameter verification failed.');
        if (find(form.newid)) return send(500, null, `CT ${form.newid} already exists`);
        state.resources.push({ vmid: Number(form.newid), type: 'lxc', node: m[1], pool: form.pool, tags: '', name: form.hostname, status: 'stopped', maxmem: src.maxmem });
        state.config.set(String(form.newid), { hostname: form.hostname, tags: '', description: '', cores: 1, memory: Math.round((src.maxmem || 0) / 1048576) });
        return send(200, newTask('vzclone', form.newid, failOn.clone ? 'clone failed' : null));
      }
      if ((m = path.match(/^\/nodes\/([^/]+)\/lxc\/(\d+)\/config$/))) {
        const r = find(m[2]);
        if (!r) return send(500, null, `Configuration file 'nodes/${m[1]}/lxc/${m[2]}.conf' does not exist`);
        const cfg = state.config.get(String(r.vmid)) || { hostname: r.name, tags: r.tags || '', description: '', cores: 1, memory: Math.round((r.maxmem || 0) / 1048576) };
        state.config.set(String(r.vmid), cfg);
        if (M === 'GET') return send(200, cfg);
        if (M === 'PUT') {
          if (form.tags !== undefined) { cfg.tags = form.tags; r.tags = form.tags; }
          if (form.description !== undefined) cfg.description = form.description;
          if (form.cores !== undefined) cfg.cores = Number(form.cores);
          if (form.memory !== undefined) { cfg.memory = Number(form.memory); r.maxmem = Number(form.memory) * 1048576; }
          return send(200, null);
        }
      }
      if ((m = path.match(/^\/nodes\/([^/]+)\/lxc\/(\d+)\/status\/(start|stop)$/)) && M === 'POST') {
        const r = find(m[2]);
        if (!r) return send(500, null, `Configuration file 'nodes/${m[1]}/lxc/${m[2]}.conf' does not exist`);
        if (m[3] === 'start') {
          if (failOn.start) return send(200, newTask('vzstart', r.vmid, 'startup failed'));
          r.status = 'running';
        } else r.status = 'stopped';
        return send(200, newTask(`vz${m[3]}`, r.vmid));
      }
      if ((m = path.match(/^\/nodes\/([^/]+)\/lxc\/(\d+)\/interfaces$/)) && M === 'GET') {
        const r = find(m[2]);
        if (!r || r.status !== 'running') return send(500, null, `CT ${m[2]} not running`);
        const list = [{ name: 'lo', inet: '127.0.0.1/8' }];
        if (!failOn.interfaces) list.push({ name: 'eth0', inet: `192.168.1.${Number(m[2]) - 9000}/24` });
        return send(200, list);
      }
      if ((m = path.match(/^\/nodes\/([^/]+)\/lxc\/(\d+)$/)) && M === 'DELETE') {
        const r = find(m[2]);
        if (!r) return send(500, null, `Configuration file 'nodes/${m[1]}/lxc/${m[2]}.conf' does not exist`);
        if (r.status !== 'stopped') return send(500, null, `CT ${m[2]} is running`);
        state.resources.splice(state.resources.indexOf(r), 1);
        state.config.delete(String(r.vmid));
        return send(200, newTask('vzdestroy', m[2]));
      }
      return send(501, null, `stub does not implement ${M} ${path}`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
