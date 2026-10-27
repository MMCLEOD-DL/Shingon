// test/factory-setup-plan.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptedAsk } from './helpers/scriptedAsk.js';
import { TEST_BRIEF } from './helpers/shipProject.js';
import { policyProblems, askDeploymentBasics, askSettings, backupProblem, backupShown, initArgs, baseSettings } from '../src/factory/ship/setupPlan.js';
import { newDeployment } from '../src/factory/deployments/store.js';

const P = TEST_BRIEF.policy;
const DEFAULTS = { matrix: { homeserver: 'https://matrix.example.org', roomId: '!alerts:example.org' } };

test('policy problems fail closed', () => {
  assert.deepEqual(policyProblems(P, { hosting: 'client-box', access: 'cloudflare-tunnel' }), []);
  assert.match(policyProblems({ ...P, operatorAccess: false }, { hosting: 'client-box', access: 'ssh' })[0], /has not agreed to your remote access/);
  assert.match(policyProblems({ ...P, outbound: [] }, { hosting: 'client-box', access: 'cloudflare-tunnel' })[0], /does not allow .*the Cloudflare tunnel lets Cloudflare see/);
  assert.equal(policyProblems({ ...P, outbound: ['Cloudflare'] }, { hosting: 'client-box', access: 'cloudflare-tunnel' }).length, 1); // free text is not an id
  assert.deepEqual(policyProblems({ ...P, outbound: [] }, { hosting: 'client-box', access: 'tailscale' }), []);
  assert.match(policyProblems(P, { hosting: 'operator-server', access: 'ssh' })[0], /client's own box, but this deployment is a server you run/);
  assert.match(policyProblems(null, { hosting: 'client-box', access: 'ssh' })[0], /no data policy/);
});

test('basics for a client box behind the Cloudflare tunnel', async () => {
  const ask = scriptedAsk(['acme-box', '', '', '', 't', 'https://staff.acme.co.uk', 'f']);
  const fields = await askDeploymentBasics(ask, { name: 'acme-office', slug: 'acme', policy: P, defaults: DEFAULTS });
  const dep = newDeployment({ ...fields, alerts: { matrix: null, webhook: false, heartbeat: false } });
  assert.equal(dep.host, 'acme-box');
  assert.deepEqual(dep.ssh, { user: 'highland', port: null, keyPath: null });
  assert.equal(dep.bundleDir, '/opt/highland/acme');
  assert.equal(dep.hosting, 'client-box');
  assert.equal(dep.access, 'cloudflare-tunnel');
  assert.equal(dep.site, ':80');
  assert.equal(dep.imageDelivery, 'tar');
});

test('a client box is offered the tunnel or Tailscale only; SSH is for a server the operator runs (S7)', async () => {
  const ask = scriptedAsk(['acme-box', '', '', '', 's']);
  await assert.rejects(askDeploymentBasics(ask, { name: 'acme-office', slug: 'acme', policy: P, defaults: DEFAULTS }), /"s" is not offered.*offered: t, n/);
});

test('a server the operator runs may use SSH, with a front door name', async () => {
  const ask = scriptedAsk(['srv.acme.co.uk', 'deploy', '2222', '/srv/acme', 's', 'https://staff.acme.co.uk', '', 'r', 'registry.example.com:5000', '', 'bot']);
  const f = await askDeploymentBasics(ask, { name: 'acme-office', slug: 'acme', policy: { ...P, hosting: 'operator-server', outbound: [] }, defaults: DEFAULTS });
  assert.equal(f.access, 'ssh');
  assert.equal(f.site, 'staff.acme.co.uk');
  assert.deepEqual(f.ssh, { user: 'deploy', port: 2222, keyPath: null });
  assert.deepEqual(f.registry, { host: 'registry.example.com:5000', namespace: 'highland-acme', user: 'bot' });
  assert.equal(f.project, 'acme');
});

test('the tunnel is refused when the policy does not list it', async () => {
  const ask = scriptedAsk(['acme-box', '', '', '', 't', 'https://staff.acme.co.uk', 'f']);
  assert.equal(await askDeploymentBasics(ask, { name: 'acme-office', slug: 'acme', policy: { ...P, outbound: [] }, defaults: DEFAULTS }), null);
  assert.match(ask.said.join('\n'), /does not allow Cloudflare Tunnel/);
});

test('settings: secrets flagged, policy confirmation asked, alerts recorded', async () => {
  const dep = newDeployment({ name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
    bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
    origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: false, heartbeat: false } });
  const ask = scriptedAsk(['smtp://u:p@smtp.acme.co.uk:587', 'hr@acme.co.uk', 'sftp:bk@backup.acme.co.uk:/srv/hf', true,
    'm', '', '', 'syt_token_value', '', 'https://kuma.example.org/api/push/abc', 'cf-tunnel-token-value']);
  const r = await askSettings(ask, { dep, policy: P, defaults: DEFAULTS });
  const byKey = Object.fromEntries(r.settings.map((s) => [s.key, s]));
  assert.equal(byKey.SMTP_URL.secret, true);
  assert.equal(byKey.EMAIL_FROM.secret, false);
  assert.equal(byKey.MATRIX_ROOM_ID.value, '!alerts:example.org');
  assert.equal(byKey.MATRIX_ACCESS_TOKEN.secret, true);
  assert.equal(byKey.TUNNEL_TOKEN.value, 'cf-tunnel-token-value');
  assert.equal('ALERT_WEBHOOK_URL' in byKey, false);
  assert.deepEqual(r.alerts, { matrix: { homeserver: 'https://matrix.example.org', roomId: '!alerts:example.org' }, webhook: false, heartbeat: true });
  assert.ok(ask.asked.some((q) => /data policy says backups go to storage the client owns \(A NAS in the client's office\), with data kept in the UK\. This box will send its encrypted backups to an SFTP server at backup\.acme\.co\.uk\./.test(q)));
});

test('declining the backup destination stops before anything is changed', async () => {
  const dep = { access: 'ssh', imageDelivery: 'tar' };
  const ask = scriptedAsk(['smtp://u:p@h:587', 'a@b.c', 'sftp:bk@backup.acme.co.uk:/srv/hf', false]);
  assert.equal(await askSettings(ask, { dep, policy: P, defaults: DEFAULTS }), null);
});

test('backup destinations: refused on the box, shown without credentials', () => {
  assert.equal(backupProblem('sftp:bk@backup.acme.co.uk:/srv/hf'), null);
  assert.match(backupProblem('/var/backups'), /must not stay on the box/);
  assert.match(backupProblem('rest:http://localhost:8000/x'), /points at the box itself/);
  assert.match(backupProblem('ftp://x'), /does not recognise/);
  assert.equal(backupShown('rest:https://u:pw@nas.acme.lan:8000/hf'), 'a restic REST server at nas.acme.lan:8000');
  assert.equal(backupShown('b2:acme-bk:hf'), 'the Backblaze B2 bucket acme-bk');
});

test('initArgs and baseSettings follow the deployment', () => {
  const dep = { origin: 'https://staff.acme.co.uk', bundleDir: '/opt/highland/acme', access: 'cloudflare-tunnel', site: ':80', imageDelivery: 'tar', registry: null };
  assert.deepEqual(initArgs(dep, TEST_BRIEF), ['init', '--client', 'Acme Ltd', '--origin', 'https://staff.acme.co.uk', '--dir', '/opt/highland/acme', '--tunnel', '--out', '/out/.env']);
  assert.deepEqual(initArgs({ ...dep, access: 'ssh', site: 'staff.acme.co.uk' }, TEST_BRIEF).slice(7, 9), ['--site', 'staff.acme.co.uk']);
  assert.deepEqual(baseSettings(dep, '0.1.3').map((s) => `${s.key}=${s.value}`), ['APP_TAG=0.1.3', 'COMPOSE_PROFILES=tunnel', 'TUNNEL_ENABLED=true']);
  assert.deepEqual(baseSettings({ ...dep, access: 'ssh', imageDelivery: 'registry', registry: { host: 'reg.example.com', namespace: 'highland-acme', user: 'u' } }, '0.1.3').map((s) => s.key),
    ['APP_TAG', 'APP_IMAGE', 'OPS_IMAGE', 'IMAGE_PULL_POLICY']);
});

test('SSH into a client box is refused with a plain message; unknown hosting is refused', () => {
  assert.match(policyProblems(P, { hosting: 'client-box', access: 'ssh' }).join(' '), /never by opening SSH to it from outside their network/);
  assert.match(policyProblems({ ...P, hosting: 'moon' }, { hosting: 'moon', access: 'tailscale' })[0], /does not say whether/);
});

test('the tunnel refusal comes before the registry questions', async () => {
  const ask = scriptedAsk(['acme-box', '', '', '', 't', 'https://staff.acme.co.uk']);
  assert.equal(await askDeploymentBasics(ask, { name: 'a', slug: 'acme', policy: { ...P, outbound: [] }, defaults: DEFAULTS }), null);
  assert.equal(ask.asked.length, 5);
});

test('s3 destination asks for its credentials; nothing secret is asked or said in clear; repo is stored trimmed', async () => {
  const dep = { access: 'ssh', imageDelivery: 'tar' };
  const ask = scriptedAsk(['smtp://u:p@h.example.org:587', 'a@b.co', '  s3:user:pw12345678@s3.eu-west-2.amazonaws.com/acme-bk  ', true,
    'AKIAEXAMPLE1234', 'secretkeyvalue99', 'eu-west-2', 'w', 'https://hooks.example.org/x1', 'skip', true]);
  const r = await askSettings(ask, { dep, policy: P, defaults: DEFAULTS });
  const by = Object.fromEntries(r.settings.map((s) => [s.key, s]));
  assert.equal(by.BACKUP_REPOSITORY.value, 's3:user:pw12345678@s3.eu-west-2.amazonaws.com/acme-bk');
  assert.equal(by.AWS_SECRET_ACCESS_KEY.secret, true);
  assert.equal(by.AWS_DEFAULT_REGION.secret, false);
  assert.equal(r.alerts.heartbeat, false);
  const text = [...ask.asked, ...ask.said].join('\n');
  for (const s of r.settings.filter((x) => x.secret)) assert.equal(text.includes(s.value), false);
  assert.ok(ask.asked.some((q) => q.includes('an S3 bucket at s3.eu-west-2.amazonaws.com/acme-bk.') && !q.includes('pw12345678')));
});

test('a registry address that looks like an option is refused at the question', async () => {
  const ask = scriptedAsk(['srv.acme.co.uk', 'deploy', '2222', '/srv/acme', 's', 'https://staff.acme.co.uk', '', 'r', '-registry.example.com']);
  await assert.rejects(askDeploymentBasics(ask, { name: 'acme-office', slug: 'acme', policy: { ...P, hosting: 'operator-server', outbound: [] }, defaults: DEFAULTS }),
    /fails the check for "Registry address/);
});
