import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const raw = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
interface Service { image: string; ports?: string[]; expose?: string[]; volumes?: string[]; profiles?: string[]; environment: Record<string, string>; networks?: any; [k: string]: any }
const c = parse(raw, { merge: true }) as { services: Record<string, Service>; networks: Record<string, any> };   // merge: true resolves `<<: *opsenv` as Compose does
const S = c.services as Record<string, Service> & { app: Service; proxy: Service; ops: Service; updater: Service; tunnel: Service };
// Comments may explain what is forbidden, so only the directives themselves are checked.
const caddyfile = readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('only the front door publishes ports; the database is never reachable from outside', () => {
  const publishing = Object.entries(S).filter(([, s]) => s.ports?.length).map(([n]) => n);
  expect(publishing).toEqual(['proxy']);
});

test('the app has no ports: it is reachable only from Caddy, so nobody can send it their own X-Forwarded-For', () => {
  expect(S.app.ports).toBeUndefined();
  expect(S.app.expose ?? []).toEqual([]);
  expect(S.app.network_mode).toBeUndefined();
  // The app trusts exactly one proxy hop, fixed in the file so a stray .env value cannot widen it.
  expect(String(S.app.environment.TRUST_PROXY_HOPS)).toBe('1');
});

test('Caddy trusts a client-address header only from the tunnel network, and always hands the app exactly one value', () => {
  const trusted = caddyfile.match(/^\s*trusted_proxies\b.*$/gm) ?? [];
  expect(trusted.map((l) => l.trim())).toEqual(['trusted_proxies static {$TUNNEL_IP}']);
  expect((caddyfile.match(/^\s*client_ip_headers\b.*$/gm) ?? []).map((l) => l.trim())).toEqual(['client_ip_headers Cf-Connecting-IP']);
  const headerUp = (caddyfile.match(/^\s*header_up\b.*$/gm) ?? []).map((l) => l.trim());
  expect(headerUp).toEqual(['header_up X-Forwarded-For {client_ip}']);
  expect(caddyfile).toMatch(/reverse_proxy app:3000/);
  expect(caddyfile).toMatch(/protocols h1 h2/);   // HTTP/3 needs 443/udp, which is not published
  expect(S.proxy.environment.TUNNEL_IP).toBe('${TUNNEL_IP:-172.30.250.10}');
  // The tunnel's address is fixed, and is the very address the Caddyfile trusts (a single host, never a subnet).
  expect(S.tunnel.networks.edge.ipv4_address).toBe('${TUNNEL_IP:-172.30.250.10}');
});

test('networks: the tunnel shares a network with the front door only; the database is on the backend alone', () => {
  const nets = (n: string): string[] => { const x = S[n]!.networks as string[] | Record<string, unknown> | undefined; return Array.isArray(x) ? x : Object.keys(x ?? {}); };
  expect(nets('tunnel').sort()).toEqual(['edge', 'tunnelmon']);
  expect(nets('proxy').sort()).toEqual(['edge', 'frontend']);
  expect(nets('app').sort()).toEqual(['backend', 'frontend']);
  for (const n of ['db', 'migrate', 'updater']) expect(nets(n), n).toEqual(['backend']);
  expect(nets('ops').sort()).toEqual(['backend', 'tunnelmon']);
  expect(Object.keys(c.networks).sort()).toEqual(['backend', 'edge', 'frontend', 'tunnelmon']);
  // The monitor's way to the tunnel: internal (no route out), and holding only ops (which listens on nothing) and the tunnel.
  expect(c.networks.tunnelmon).toEqual({ internal: true });
  expect(Object.keys(S).filter((n) => nets(n).includes('tunnelmon')).sort()).toEqual(['ops', 'tunnel']);
  expect(S.ops.ports).toBeUndefined();
  expect(S.ops.expose).toBeUndefined();
  expect(c.networks.edge.ipam.config[0].subnet).toBe('${EDGE_SUBNET:-172.30.250.0/28}');
  // Nothing may share a network with the tunnel except the proxy.
  const withTunnelNet = Object.keys(S).filter((n) => nets(n).includes('edge')).sort();
  expect(withTunnelNet).toEqual(['proxy', 'tunnel']);
});

test('the tunnel is outbound-only, optional and pinned', () => {
  expect(S.tunnel.profiles).toEqual(['tunnel']);
  expect(S.tunnel.ports).toBeUndefined();
  expect(S.tunnel.command).toContain('--no-autoupdate');
  expect(S.tunnel.environment.TUNNEL_TOKEN).toBe('${TUNNEL_TOKEN:-}');
});

test('only the on-demand updater gets the Docker socket', () => {
  const withSock = Object.entries(S).filter(([, s]) => (s.volumes ?? []).some((v) => v.includes('docker.sock'))).map(([n]) => n);
  expect(withSock).toEqual(['updater']);
  expect(S.updater.profiles).toEqual(['tools']);
  expect(S.updater.restart).toBeUndefined();
  for (const n of ['app', 'ops']) {
    expect(S[n]!.privileged, n).toBeUndefined();
    expect(S[n]!.pid, n).toBeUndefined();
    expect(S[n]!.environment.DOCKER_HOST, n).toBeUndefined();
  }
});

test('the updater has every setting the ops daemon has, plus the bundle path', () => {
  const ops = Object.keys(S.ops.environment);
  const upd = Object.keys(S.updater.environment);
  expect(ops.filter((k) => !upd.includes(k))).toEqual([]);
  for (const k of ['COMPOSE_PROJECT_NAME', 'INSTANCE_MODE', 'BACKUP_ALLOW_LOCAL', 'APP_INTERNAL_URL', 'AWS_SECRET_ACCESS_KEY', 'B2_ACCOUNT_KEY', 'RESTIC_REST_PASSWORD'])
    expect(upd, k).toContain(k);
  expect(upd).toContain('HF_BUNDLE_DIR');
});

test('the app container gets no backup or alert secrets', () => {
  const env = Object.keys(S.app.environment);
  for (const k of ['BACKUP_PASSWORD', 'BACKUP_REPOSITORY', 'MATRIX_ACCESS_TOKEN', 'TUNNEL_TOKEN', 'AWS_SECRET_ACCESS_KEY']) expect(env).not.toContain(k);
});

test('third-party images are pinned to a version, never latest', () => {
  for (const [n, s] of Object.entries(S)) {
    const img = s.image;
    if (img.includes('${')) continue;           // our own images, tagged by APP_TAG
    expect(img, n).toMatch(/:[0-9]+\.[0-9]+[^:]*$/);   // an exact tag such as 17.11-bookworm, not a floating 17 or 2
    expect(img, n).not.toMatch(/:latest$/);
  }
});

test('nothing runs privileged or as an unneeded extra-powerful container', () => {
  for (const [n, s] of Object.entries(S)) {
    expect(s.privileged, n).toBeUndefined();
    expect(s.cap_add ?? [], n).not.toContain('SYS_ADMIN');
    expect(s.network_mode, n).not.toBe('host');
  }
});

test('the long-running web-facing containers are locked down: read-only files, no extra powers', () => {
  for (const n of ['app', 'migrate', 'proxy']) {
    expect(S[n]!.read_only, n).toBe(true);
    expect(S[n]!.cap_drop, n).toContain('ALL');
    expect(S[n]!.security_opt, n).toContain('no-new-privileges:true');
  }
  expect(S.app.user ?? 'node').toBe('node');
});

test('every ${VAR} used is documented in .env.example', () => {
  const used = new Set([...raw.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]!));
  const documented = new Set([...readFileSync(new URL('../.env.example', import.meta.url), 'utf8').matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]!));
  expect([...used].filter((v) => !documented.has(v))).toEqual([]);
});

test('.env.example holds placeholders only, never a real-looking secret', () => {
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const m of env.matchAll(/^#?\s*(DB_PASSWORD|HEALTH_TOKEN|BACKUP_PASSWORD|TUNNEL_TOKEN|MATRIX_ACCESS_TOKEN|AWS_SECRET_ACCESS_KEY|B2_ACCOUNT_KEY|RESTIC_REST_PASSWORD)=(.*)$/gm))
    expect(m[2]!.trim(), m[1]).toBe('');
});

test('the image files bake in no secrets and create the uploads folder owned by uid 1000', () => {
  for (const f of ['../Dockerfile', '../ops.Dockerfile']) {
    const d = readFileSync(new URL(f, import.meta.url), 'utf8');
    expect(d, f).not.toMatch(/^\s*(ENV|ARG)\s+\w*(PASSWORD|TOKEN|SECRET)\w*/im);
    expect(d, f).not.toMatch(/COPY[^\n]*\.env\b/);
    expect(d, f).toMatch(/mkdir -p \/data\/uploads && chown (node:node|1000:1000) \/data\/uploads/);
  }
  const app = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  expect(app).toMatch(/^USER node$/m);
  expect(app.indexOf('chown node:node /data/uploads')).toBeLessThan(app.indexOf('USER node'));
  expect(app).toContain('foundation.json');
});

test('the long-running ops daemon is locked down too: read-only, the app\'s own user, no extra powers, no socket', () => {
  const ops = S.ops;
  expect(ops.command).toEqual(['daemon']);
  expect(ops.read_only).toBe(true);
  expect(ops.tmpfs).toContain('/tmp');
  expect(ops.cap_drop).toEqual(['ALL']);
  // Task 20: as uid 1000 (the uploads' owner) it needs no CHOWN/DAC_OVERRIDE/FOWNER; the updater hands /state back to 1000.
  expect(ops.user).toBe('1000:1000');
  expect(ops.cap_add).toBeUndefined();
  expect(ops.security_opt).toContain('no-new-privileges:true');
  expect((ops.volumes ?? []).some((v: string) => v.includes('docker.sock'))).toBe(false);
  expect(ops.ports).toBeUndefined();
});

test('the ops image gives a fresh state volume to uid 1000, and the updater (root, with the socket) hands it back after an update', () => {
  const dockerfile = readFileSync(new URL('../ops.Dockerfile', import.meta.url), 'utf8');
  expect(dockerfile).toContain('install -d -m 0700 -o 1000 -g 1000 /state');
  // The updater's working_dir is the bundle folder, so a relative entrypoint would not be found (seen live in Task 20).
  expect(S.updater.working_dir).toBe('${HF_BUNDLE_DIR:?}');
  expect(dockerfile).toMatch(/^ENTRYPOINT \["node", "\/app\/ops\/dist\/cli\.js"\]$/m);
  expect(S.updater.user).toBeUndefined();
  expect(S.updater.volumes).toContain('state:/state');
});

test('our images are never pulled by default: highland/app and highland/ops on Docker Hub belong to someone else', () => {
  for (const n of ['migrate', 'app', 'ops', 'edge-check', 'updater']) {
    expect(S[n]!.pull_policy, n).toBe('${IMAGE_PULL_POLICY:-never}');
  }
  expect(S.proxy.pull_policy).toBeUndefined();   // third-party images keep the normal policy
});

test('a mismatched tunnel address and edge network keeps only the front door down, checked by a locked-down one-shot service', () => {
  const e = S['edge-check']!;
  expect(e.image).toBe('${OPS_IMAGE:-highland/ops}:${APP_TAG}');
  expect(e.command).toEqual(['check-edge']);
  expect(e.environment).toEqual({ TUNNEL_IP: S.proxy.environment.TUNNEL_IP, EDGE_SUBNET: '${EDGE_SUBNET:-172.30.250.0/28}' });
  expect(e.volumes).toBeUndefined();
  expect(e.network_mode).toBe('none');
  expect(e.read_only).toBe(true);
  expect(e.cap_drop).toEqual(['ALL']);
  expect(e.cap_add).toBeUndefined();
  expect(e.security_opt).toContain('no-new-privileges:true');
  expect(e.restart).toBe('no');
  expect(S.proxy.depends_on['edge-check']).toEqual({ condition: 'service_completed_successfully' });
  // Nothing else waits for it: the app, the database and ops (backups) start whatever the tunnel settings say.
  for (const n of ['app', 'db', 'ops', 'migrate']) expect(Object.keys((S[n]!.depends_on ?? {}) as Record<string, unknown>), n).not.toContain('edge-check');
});

test('ops sees the same tunnel address and edge network as the front door, so it can warn about a mismatched pair', () => {
  expect(S.ops.environment.TUNNEL_IP).toBe(S.proxy.environment.TUNNEL_IP);
  expect(S.ops.environment.TUNNEL_IP).toBe(S.tunnel.networks.edge.ipv4_address);
  expect(S.ops.environment.EDGE_SUBNET).toBe(c.networks.edge.ipam.config[0].subnet);
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  expect(env).toMatch(/change both together/i);
});

test('the ops image trusts only the pinned apt keys, never a whole downloaded key file', () => {
  const d = readFileSync(new URL('../ops.Dockerfile', import.meta.url), 'utf8');
  expect(d).not.toMatch(/gpg --dearmor/);
  expect(d).toMatch(/pin-apt-key \/tmp\/pgdg\.asc "\$\{PGDG_KEY_FPR\}" \/etc\/apt\/keyrings\/pgdg\.gpg/);
  expect(d).toMatch(/pin-apt-key \/tmp\/docker\.asc "\$\{DOCKER_KEY_FPR\}" \/etc\/apt\/keyrings\/docker\.gpg/);
});

test('while the app is down the front door shows a plain "being updated" page with the real status, holding no settings', () => {
  const block = caddyfile.slice(caddyfile.indexOf('handle_errors'));
  expect(caddyfile).toMatch(/^\s*handle_errors 502 503 504 \{$/m);
  expect(block).toContain('The app is being updated');
  expect(block).toContain('back in a few minutes');
  expect(block).toMatch(/^\s*HTML \{err\.status_code\}$/m);            // the status stays 502/503/504, never 200
  expect(block).toMatch(/header Cache-Control "no-store"/);
  // static: no environment value ({$...}) or request value ({http....}) is put into the page
  const page = block.slice(block.indexOf('<<HTML'), block.indexOf('HTML {err.status_code}'));
  expect(page).not.toMatch(/\{\$|\{http\.|\{env\./);
  expect(page).not.toMatch(/<script|src=|href=/i);                       // nothing loaded from anywhere
});

test('the production app build leaves out the test-only e2e server', () => {
  const build = JSON.parse(readFileSync(new URL('../../apps/server/tsconfig.build.json', import.meta.url), 'utf8')) as { exclude?: string[] };
  expect(build.exclude).toContain('src/e2e-server.ts');
});
