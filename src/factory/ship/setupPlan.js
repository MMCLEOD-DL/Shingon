// src/factory/ship/setupPlan.js — the plain-English questions for a first ship, checked against the brief's data policy,
// turned into the fields of a deployment record and the list of .env settings. Secrets live in memory only.
import { OUTBOUND_SERVICES } from '../outbound.js';
import { targetProblem } from './remote.js';
import { USER_RE, BUNDLE_RE, REG_HOST_RE, REG_NS_RE, validOrigin } from '../deployments/store.js';

const CLIENT_BOX = "The brief says this app runs on the client's own box.";
const OPERATOR_SERVER = 'The brief says this app runs on a server you run.';

export function policyProblems(policy, { hosting, access }) {
  if (!policy || typeof policy !== 'object') {
    return ['The approved brief has no data policy, so Conductor cannot decide how to set up the box. Revise the brief.'];
  }
  const problems = [];
  if (policy.operatorAccess !== true) {
    problems.push("The client has not agreed to your remote access (the brief's data policy). Shipping needs it, so that you can fix things in flight.");
  }
  if (hosting !== policy.hosting) {
    problems.push(policy.hosting === 'client-box'
      ? "The brief says the app runs on the client's own box, but this deployment is a server you run."
      : "The brief says the app runs on a server you run, but this deployment is the client's own box.");
  }
  if (access === 'cloudflare-tunnel' && !(Array.isArray(policy.outbound) && policy.outbound.includes('cloudflare-tunnel'))) {
    problems.push(`The data policy does not allow ${OUTBOUND_SERVICES['cloudflare-tunnel'].label}, and the Cloudflare tunnel lets Cloudflare see the app's traffic. Choose Tailscale instead (set up by hand: RUNBOOK.md, "Tailscale instead of Cloudflare"), or revise the brief to allow it.`);
  }
  if (access === 'ssh' && hosting === 'client-box') {
    problems.push("A client's own box is reached through the Cloudflare tunnel or Tailscale, never by opening SSH to it from outside their network.");
  }
  return problems;
}

const NOT_ASKED = 'No answer was given, so nothing has been set up.';

function refuse(ask, problems) {
  for (const p of problems) ask.say(p);
  return null;
}

export async function askDeploymentBasics(ask, { name, slug, policy, defaults: _defaults }) {
  const early = policyProblems(policy, { hosting: policy?.hosting, access: null });
  if (early.length) return refuse(ask, early);
  const hosting = policy.hosting;
  ask.say(hosting === 'client-box' ? CLIENT_BOX : OPERATOR_SERVER);

  const host = await ask.text("What is the box's address or SSH alias? (for example acme-box or 192.168.1.50)", {
    check: (a) => (a === '' ? 'Type the box\'s address or SSH alias.' : targetProblem({ host: a, user: 'highland' })),
  });
  if (host === null) return refuse(ask, [NOT_ASKED]);
  const user = await ask.text('Which user should Conductor log in as on the box?', {
    def: 'highland', check: (a) => (USER_RE.test(a) ? null : 'Use a plain lower-case user name, such as highland.'),
  });
  if (user === null) return refuse(ask, [NOT_ASKED]);
  const portText = await ask.text('Which SSH port?', {
    def: '22', check: (a) => (/^\d{1,5}$/.test(a) && Number(a) >= 1 && Number(a) <= 65535 ? null : 'Type a port number from 1 to 65535.'),
  });
  if (portText === null) return refuse(ask, [NOT_ASKED]);
  const port = Number(portText) === 22 ? null : Number(portText);
  const bundleDir = await ask.text('Which folder on the box holds this deployment?', {
    def: `/opt/highland/${slug}`,
    check: (a) => (BUNDLE_RE.test(a) && !a.split('/').includes('..') && a !== '/'
      ? null : 'Use a full path made of letters, digits, ".", "_", "-" and "/", for example /opt/highland/acme.'),
  });
  if (bundleDir === null) return refuse(ask, [NOT_ASKED]);

  const choices = [
    { key: 't', label: 'Cloudflare tunnel (outbound only, nothing opened on the client\'s network)' },
    ...(hosting === 'operator-server' ? [{ key: 's', label: 'SSH directly (a rented server, or a VPN)' }] : []),
    { key: 'n', label: 'Tailscale (you set it up by hand, see the runbook)' },
  ];
  const pick = await ask.choose('How will you reach this box from outside?', choices);
  if (pick === null) return refuse(ask, [NOT_ASKED]);
  const access = { t: 'cloudflare-tunnel', s: 'ssh', n: 'tailscale' }[pick];

  const origin = await ask.text('What web address will staff type? (for example https://staff.acme.co.uk)', {
    check: (a) => (validOrigin(a) ? null : 'Type the address like https://staff.acme.co.uk, with nothing after the host name.'),
  });
  if (origin === null) return refuse(ask, [NOT_ASKED]);

  let site = ':80';
  if (access !== 'cloudflare-tunnel') {
    site = await ask.text("What should the front door answer to? Use the public name for automatic HTTPS, or :80 for plain HTTP on the client's network.", {
      def: new URL(origin).host,
      check: (a) => (/^[A-Za-z0-9.:*-]+$/.test(a) ? null : 'Type a host name such as staff.acme.co.uk, or :80.'),
    });
    if (site === null) return refuse(ask, [NOT_ASKED]);
  }

  const how = await ask.choose("How should the app's images reach the box?", [
    { key: 'f', label: 'a file copied over SSH (simplest)' },
    { key: 'r', label: 'your private registry' },
  ]);
  if (how === null) return refuse(ask, [NOT_ASKED]);
  let imageDelivery = 'tar';
  let registry = null;
  if (how === 'r') {
    const regHost = await ask.text('Registry address? (for example registry.example.com)', {
      check: (a) => (REG_HOST_RE.test(a) ? null : 'Type just the registry\'s address, such as registry.example.com.'),
    });
    if (regHost === null) return refuse(ask, [NOT_ASKED]);
    const namespace = await ask.text('Image folder in the registry?', {
      def: `highland-${slug}`, check: (a) => (REG_NS_RE.test(a) ? null : 'Use lower-case letters, digits, ".", "_", "-" and "/".'),
    });
    if (namespace === null) return refuse(ask, [NOT_ASKED]);
    const regUser = await ask.text('Registry user name for this box?', {
      check: (a) => (/^[^\s'"\\$`]+$/.test(a) ? null : 'Type the user name, with no spaces or quote marks.'),
    });
    if (regUser === null) return refuse(ask, [NOT_ASKED]);
    imageDelivery = 'registry';
    registry = { host: regHost, namespace, user: regUser };
  }

  const problems = policyProblems(policy, { hosting, access });
  if (problems.length) return refuse(ask, problems);

  return { name, project: slug, host, ssh: { user, port, keyPath: null }, bundleDir, hosting, imageDelivery, registry, access, origin, site };
}

// ---- backup destination ----

const LOOPBACK = (h) => {
  const x = String(h).toLowerCase().replace(/^\[|\]$/g, '');
  return x === 'localhost' || x === '::1' || x === '0.0.0.0' || /^127\./.test(x);
};
const ON_BOX = 'The backup destination points at the box itself. Backups must leave the box.';

function sftpHost(rest) {
  const m = /^(?:\/\/)?(?:[^@/]*@)?(\[[^\]]+\]|[^:/@[\]]+)(?::.*)?$/.exec(rest);
  return m ? m[1] : null;
}
function s3Parts(rest) {
  const m = /^(?:https?:\/\/)?([^/\s]+)\/(.+)$/.exec(rest);
  return m ? { host: m[1], path: m[2], whole: `${m[1]}/${m[2]}` } : null;
}

export function backupProblem(repo) {
  const r = typeof repo === 'string' ? repo.trim() : '';
  if (/^[/.~]/.test(r) || /^local:/i.test(r)) {
    return 'Backups must not stay on the box. Use sftp:, rest:, s3: or b2: to send them to another place.';
  }
  const unknown = 'Conductor does not recognise that backup destination. Use sftp:, rest:, s3: or b2:.';
  if (r === '' || /\s/.test(r)) return unknown;
  if (r.startsWith('sftp:')) {
    const h = sftpHost(r.slice(5));
    if (!h) return unknown;
    return LOOPBACK(h) ? ON_BOX : null;
  }
  if (r.startsWith('rest:')) {
    let u;
    try { u = new URL(r.slice(5)); } catch { return unknown; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return unknown;
    return LOOPBACK(u.hostname) ? ON_BOX : null;
  }
  if (r.startsWith('s3:')) {
    const p = s3Parts(r.slice(3));
    if (!p) return unknown;
    return LOOPBACK(p.host.replace(/:\d+$/, '')) ? ON_BOX : null;
  }
  if (r.startsWith('b2:')) return /^b2:[^:]+(:.*)?$/.test(r) ? null : unknown;
  return unknown;
}

// Never includes a user name or password.
export function backupShown(repo) {
  const r = typeof repo === 'string' ? repo.trim() : '';
  if (r.startsWith('sftp:')) { const h = sftpHost(r.slice(5)); if (h) return `an SFTP server at ${h}`; }
  if (r.startsWith('rest:')) { try { return `a restic REST server at ${new URL(r.slice(5)).host}`; } catch { /* fall through */ } }
  if (r.startsWith('s3:')) { const p = s3Parts(r.slice(3)); if (p) return `an S3 bucket at ${p.whole}`; }
  if (r.startsWith('b2:')) { const m = /^b2:([^:]+)/.exec(r); if (m) return `the Backblaze B2 bucket ${m[1]}`; }
  return 'a backup destination Conductor does not recognise';
}

const KIND_TEXT = { 'client-owned': 'storage the client owns', 'operator-run': 'storage you run', 'cloud-bucket': 'a cloud bucket' };
const RESIDENCY_TEXT = { uk: 'in the UK', 'uk-eu': 'in the UK or EU', any: 'anywhere' };

export async function askSettings(ask, { dep, policy, defaults }) {
  const settings = [];
  const add = (key, value, secret) => { settings.push({ key, value, secret }); };

  const smtp = await ask.secret('Mail server address for invitations and password resets (for example smtp://user:password@smtp.example.co.uk:587)', {
    check: (a) => (/^smtps?:\/\//.test(a) ? null : 'The mail server address must start with smtp:// or smtps://.'),
  });
  if (smtp === null) return refuse(ask, [NOT_ASKED]);
  add('SMTP_URL', smtp, true);
  const from = await ask.text('Sender address for those emails?', { check: (a) => (a.includes('@') ? null : 'Type an email address, such as hr@acme.co.uk.') });
  if (from === null) return refuse(ask, [NOT_ASKED]);
  add('EMAIL_FROM', from, false);

  const repo = await ask.secret('Backup destination (for example sftp:backup@host:/path, rest:https://host:8000/repo, s3:… or b2:…)', {
    check: (a) => backupProblem(a),
  });
  if (repo === null) return refuse(ask, [NOT_ASKED]);
  const bd = policy?.backupDestination;
  const kindText = KIND_TEXT[bd?.kind] ?? 'storage the brief names';
  const detail = bd?.detail ? ` (${bd.detail})` : '';
  const okay = await ask.confirm(`The client's data policy says backups go to ${kindText}${detail}, with data kept ${RESIDENCY_TEXT[policy?.residency] ?? 'where the brief says'}. This box will send its encrypted backups to ${backupShown(repo)}. Is that right?`);
  if (!okay) return refuse(ask, ['Nothing has been changed on the box.']);
  add('BACKUP_REPOSITORY', repo, true);

  const scheme = repo.slice(0, repo.indexOf(':') + 1);
  const need = async (q, key, { optional = false, visible = false } = {}) => {
    const v = visible ? await ask.text(q, { def: '' }) : await ask.secret(q, { optional });
    if (v === null) return null;
    if (v !== '') add(key, v, !visible);
    return v;
  };
  if (scheme === 's3:') {
    if (await need('S3 access key id', 'AWS_ACCESS_KEY_ID') === null) return refuse(ask, [NOT_ASKED]);
    if (await need('S3 secret access key', 'AWS_SECRET_ACCESS_KEY') === null) return refuse(ask, [NOT_ASKED]);
    if (await need('S3 region (or press Enter to leave it out)', 'AWS_DEFAULT_REGION', { visible: true }) === null) return refuse(ask, [NOT_ASKED]);
  } else if (scheme === 'b2:') {
    if (await need('Backblaze account id', 'B2_ACCOUNT_ID') === null) return refuse(ask, [NOT_ASKED]);
    if (await need('Backblaze account key', 'B2_ACCOUNT_KEY') === null) return refuse(ask, [NOT_ASKED]);
  } else if (scheme === 'rest:') {
    if (await need('Backup server user name (or press Enter for none)', 'RESTIC_REST_USERNAME', { visible: true }) === null) return refuse(ask, [NOT_ASKED]);
    if (await need('Backup server password (or press Enter for none)', 'RESTIC_REST_PASSWORD', { optional: true }) === null) return refuse(ask, [NOT_ASKED]);
  } else {
    ask.say("For sftp, the box's own SSH key must be allowed on the backup server.");
  }

  const where = await ask.choose('Where should alerts go?', [
    { key: 'm', label: 'Matrix (your usual alerts room)' },
    { key: 'w', label: 'a webhook only' },
  ]);
  if (where === null) return refuse(ask, [NOT_ASKED]);
  let matrix = null;
  if (where === 'm') {
    const homeserver = await ask.text('Matrix homeserver address?', {
      def: defaults?.matrix?.homeserver, check: (a) => (/^https?:\/\/\S+$/.test(a) ? null : 'Type the address, starting with https://.'),
    });
    if (homeserver === null) return refuse(ask, [NOT_ASKED]);
    const roomId = await ask.text('Matrix room id for alerts? (looks like !abc:example.org)', {
      def: defaults?.matrix?.roomId, check: (a) => (/^!.+:.+$/.test(a) ? null : 'A room id looks like !abc:example.org.'),
    });
    if (roomId === null) return refuse(ask, [NOT_ASKED]);
    const token = await ask.secret("The Matrix bot's access token", {});
    if (token === null) return refuse(ask, [NOT_ASKED]);
    add('MATRIX_HOMESERVER', homeserver, false);
    add('MATRIX_ROOM_ID', roomId, false);
    add('MATRIX_ACCESS_TOKEN', token, true);
    matrix = { homeserver, roomId };
  }
  const hookCheck = (a) => (/^https?:\/\/\S+$/.test(a) ? null : 'A webhook address starts with http:// or https://.');
  const hook = await ask.secret(where === 'w' ? 'Webhook address for alerts' : 'Also send alerts to a webhook? Paste its address, or press Enter for none.',
    { optional: where === 'm', check: hookCheck });
  if (hook === null) return refuse(ask, [NOT_ASKED]);
  if (hook !== '') add('ALERT_WEBHOOK_URL', hook, true);

  let heartbeat = false;
  for (;;) {
    const beat = await ask.secret('Uptime Kuma push address for this box (or type skip)', {
      check: (a) => (a === 'skip' || /^https?:\/\/\S+$/.test(a) ? null : 'Type the push address (starting with https://) or skip.'),
    });
    if (beat === null) return refuse(ask, [NOT_ASKED]);
    if (beat !== 'skip') { add('HEARTBEAT_URL', beat, true); heartbeat = true; break; }
    if (await ask.confirm('Without an outside watcher, nobody notices if the whole box goes off. Ship without one?')) break;
  }

  if (dep?.access === 'cloudflare-tunnel') {
    const t = await ask.secret('Tunnel token from the Cloudflare dashboard');
    if (t === null) return refuse(ask, [NOT_ASKED]);
    add('TUNNEL_TOKEN', t, true);
  }

  return { settings, alerts: { matrix, webhook: hook !== '', heartbeat } };
}

export function baseSettings(dep, version) {
  const out = [{ key: 'APP_TAG', value: version, secret: false }];
  if (dep.imageDelivery === 'registry' && dep.registry) {
    const base = `${dep.registry.host}/${dep.registry.namespace}`;
    out.push({ key: 'APP_IMAGE', value: `${base}/app`, secret: false },
      { key: 'OPS_IMAGE', value: `${base}/ops`, secret: false },
      { key: 'IMAGE_PULL_POLICY', value: 'missing', secret: false });
  }
  if (dep.access === 'cloudflare-tunnel') {
    out.push({ key: 'COMPOSE_PROFILES', value: 'tunnel', secret: false }, { key: 'TUNNEL_ENABLED', value: 'true', secret: false });
  }
  return out;
}

export function initArgs(dep, brief) {
  return ['init', '--client', brief.client, '--origin', dep.origin, '--dir', dep.bundleDir,
    ...(dep.access === 'cloudflare-tunnel' ? ['--tunnel'] : ['--site', dep.site]), '--out', '/out/.env'];
}
