import { randomBytes } from 'node:crypto';

export interface InitOptions {
  client: string;
  origin: string;
  siteAddress: string;
  bundleDir: string;
  mode: 'demo' | 'production';
  /** The box is reached through the outbound tunnel: the front door must answer plain HTTP on :80 and the monitor watches the tunnel. */
  tunnel?: boolean;
  random?: (bytes: number) => string;
}

/** One line of the generated file. `value` undefined means "written commented out, for the operator to fill in". */
interface Entry { key: string; comment: string; value?: string; example?: string }

const defaultRandom = (n: number): string => randomBytes(n).toString('base64url');

/** A value Compose reads back exactly as written, whatever the client's name contains. */
function dotenvValue(key: string, v: string): string {
  if (/[\r\n]/.test(v)) throw new Error(`${key} must be on one line.`);
  if (/^[A-Za-z0-9_@%+=:,./ -]*$/.test(v) && v === v.trim()) return v;
  // Double quotes keep spaces and # and ' as they are; \ and " are escaped and $ is doubled so Compose does not expand it.
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$')}"`;
}

export function generateEnv(opts: InitOptions): { env: string; checklist: string } {
  const random = opts.random ?? defaultRandom;
  const client = opts.client.trim();
  if (client === '') throw new Error('--client needs the client\'s name, such as "Acme Ltd".');
  let origin: string;
  try {
    const u = new URL(opts.origin);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '' || u.pathname !== '/' || u.search !== '' || u.hash !== '') throw new Error('bad');
    origin = u.origin;
  } catch {
    throw new Error('--origin must be just the web address, such as https://app.client.co.uk (or http://... on a LAN), with no path, login or extra parts.');
  }
  const siteAddress = opts.tunnel === true ? ':80' : opts.siteAddress;
  const secret = (): string => random(32);
  const sections: { heading: string; entries: Entry[] }[] = [
    {
      heading: 'The app',
      entries: [
        { key: 'COMPOSE_PROJECT_NAME', comment: 'Name of this Compose project. Only change it if two deployments share one machine.', example: 'highland' },
        { key: 'APP_IMAGE', comment: 'Which app and ops images to run. Set by the release you installed; `ops update` changes APP_TAG.', example: 'highland/app' },
        { key: 'OPS_IMAGE', comment: 'The ops image.', example: 'highland/ops' },
        { key: 'APP_TAG', comment: 'The release to run, such as 0.1.0. Write it here before the first start.', example: '' },
        { key: 'UPDATER_TAG', comment: 'The release the updater runs (defaults to APP_TAG).', example: '' },
        { key: 'APP_NAME', comment: 'The name shown to staff in the app and in emails.', value: client },
        { key: 'APP_ORIGIN', comment: 'The web address staff use.', value: origin },
        { key: 'INSTANCE_MODE', comment: 'production for a live box. demo is for made-up data only.', value: opts.mode },
        { key: 'CLIENT_LABEL', comment: "The client's name, used in alerts so you can tell the boxes apart.", value: client },
        { key: 'DB_PASSWORD', comment: 'Database password (random).', value: secret() },
        { key: 'HEALTH_TOKEN', comment: 'Lets monitoring read the detailed health and version (random).', value: secret() },
        { key: 'SITE_ADDRESS', comment: 'What the front door answers to: :80 for plain HTTP, or a public name for automatic HTTPS. With the tunnel it must be :80.', value: siteAddress },
        { key: 'EDGE_SUBNET', comment: 'The private network between the front door and the tunnel. Change it only if it clashes with a network you use.', example: '172.30.250.0/28' },
        { key: 'TUNNEL_IP', comment: "The tunnel's fixed address on that network (inside EDGE_SUBNET). Only this address is believed about a visitor's real address.", example: '172.30.250.10' },
        { key: 'HTTP_PORT', comment: 'Ports the front door listens on, if 80 and 443 are in use.', example: '80' },
        { key: 'HTTPS_PORT', comment: 'The HTTPS port.', example: '443' },
        { key: 'HF_BUNDLE_DIR', comment: 'The full path of the folder holding this file on the machine. The updater needs it.', value: opts.bundleDir },
      ],
    },
    {
      heading: 'Mail',
      entries: [
        { key: 'SMTP_URL', comment: 'Where the app sends mail, such as smtp://user:password@smtp.example.co.uk:587. Fill this in.', value: '' },
        { key: 'EMAIL_FROM', comment: 'The sender address on invitation and password-reset emails. Fill this in.', value: '' },
      ],
    },
    {
      heading: "Backups (where they go is set by the client's data policy)",
      entries: [
        { key: 'BACKUP_REPOSITORY', comment: 'Where backups are stored, such as sftp:backup@host:/path or s3:s3.example.com/bucket. Fill this in.', value: '' },
        { key: 'BACKUP_PASSWORD', comment: 'The password that locks the backups (random). Keep a copy off this machine.', value: secret() },
        { key: 'BACKUP_ALLOW_LOCAL', comment: 'Development only: allow a backup folder on this same machine. Never true on a live box.', example: 'false' },
        { key: 'BACKUP_SCHEDULE', comment: 'When backups run (cron, UK time).', example: '30 2 * * *' },
        { key: 'RESTORE_TEST_SCHEDULE', comment: 'When a test restore runs.', example: '30 4 * * 0' },
        { key: 'BACKUP_KEEP', comment: 'How many old backups to keep.', example: '--keep-daily 7 --keep-weekly 5 --keep-monthly 12' },
        { key: 'AUDIT_RETENTION_DAYS', comment: 'How many days of the audit log to keep.', example: '730' },
        { key: 'AWS_ACCESS_KEY_ID', comment: 'Sign-in details for an S3-compatible backup destination.', example: '' },
        { key: 'AWS_SECRET_ACCESS_KEY', comment: 'The matching secret.', example: '' },
        { key: 'B2_ACCOUNT_ID', comment: 'Sign-in details for a Backblaze B2 backup destination.', example: '' },
        { key: 'B2_ACCOUNT_KEY', comment: 'The matching key.', example: '' },
        { key: 'RESTIC_REST_USERNAME', comment: 'Sign-in details for a password-protected restic REST server.', example: '' },
        { key: 'RESTIC_REST_PASSWORD', comment: 'The matching password.', example: '' },
      ],
    },
    {
      heading: 'Alerts',
      entries: [
        { key: 'MATRIX_HOMESERVER', comment: 'Matrix room that gets the alerts: the server address,', example: '' },
        { key: 'MATRIX_ACCESS_TOKEN', comment: 'an access token for the alert bot,', example: '' },
        { key: 'MATRIX_ROOM_ID', comment: 'and the room id.', example: '' },
        { key: 'ALERT_WEBHOOK_URL', comment: 'Optional second route: a web address that receives each alert as a JSON message.', example: '' },
        { key: 'HEARTBEAT_URL', comment: "Optional web address pinged regularly, so a dead-man's-switch service can tell you if this box goes silent.", example: '' },
      ],
    },
    {
      heading: 'Remote access (outbound tunnel)',
      entries: [
        { key: 'TUNNEL_TOKEN', comment: "Token from the tunnel provider's dashboard. Start with `--profile tunnel`. Nothing is opened inbound.", example: '' },
        { key: 'TUNNEL_ENABLED', comment: 'Set to true when the tunnel is in use, so the monitor watches it.', ...(opts.tunnel === true ? { value: 'true' } : { example: 'false' }) },
      ],
    },
  ];

  const lines: string[] = [
    `# Highland deployment settings for ${client.replace(/[\r\n]+/g, ' ')}.`,
    '# Made by `ops init`. It holds secrets: keep it out of git and off shared drives.',
  ];
  for (const s of sections) {
    lines.push('', `# ${s.heading}`);
    for (const e of s.entries) {
      lines.push(`# ${e.comment}`);
      lines.push(e.value !== undefined ? `${e.key}=${dotenvValue(e.key, e.value)}` : `# ${e.key}=${e.example ?? ''}`);
    }
  }

  const checklist = [
    `Setting up ${client.replace(/[\r\n]+/g, ' ')}. Do these before you start the box:`,
    '',
    '1. Save BACKUP_PASSWORD in your password manager now. Without it the backups cannot be read, and it must not live only on this box.',
    '2. Fill in SMTP_URL and EMAIL_FROM in .env, so invitations and password resets can be emailed.',
    "3. Set BACKUP_REPOSITORY to the destination in the client's data policy (never only a folder on this machine).",
    '4. Set the Matrix alert details (MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN and MATRIX_ROOM_ID) so a failed backup or a stopped app reaches you.',
    opts.tunnel === true
      ? '5. Put the tunnel token in TUNNEL_TOKEN and add --profile tunnel when starting. SITE_ADDRESS has been set to :80 for the tunnel; leave APP_ORIGIN as the https:// address.'
      : '5. Optional: for remote access without opening the client network, put the tunnel token in TUNNEL_TOKEN, set TUNNEL_ENABLED=true, and add --profile tunnel when starting. With the tunnel, SITE_ADDRESS must be :80 (keep APP_ORIGIN as https://), or visitors loop forever; `ops init --tunnel` does this for you.',
    '',
    'Also write the release you are installing into .env as APP_TAG (for example APP_TAG=0.1.0).',
    '',
  ].join('\n');

  return { env: lines.join('\n') + '\n', checklist };
}
