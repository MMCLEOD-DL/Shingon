import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const raw = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
interface Service { image: string; ports?: string[]; expose?: string[]; volumes?: string[]; profiles?: string[]; environment: Record<string, string>; [k: string]: any }
const c = parse(raw, { merge: true }) as { services: Record<string, Service> };   // merge: true resolves `<<: *opsenv` as Compose does
const S = c.services as Record<string, Service> & { app: Service; ops: Service; updater: Service; tunnel: Service };
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

test('Caddy overwrites the client address and is never told to trust client-supplied forwarding headers', () => {
  expect(caddyfile).not.toMatch(/trusted_proxies/);
  expect(caddyfile).not.toMatch(/header_up/);
  expect(caddyfile).toMatch(/reverse_proxy app:3000/);
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
