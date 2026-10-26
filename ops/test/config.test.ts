import { test, expect } from 'vitest';
import { assertOffBox, describeRepo, repoPassword, checkEdgePair, loadOpsConfig, OpsConfigError } from '../src/config.js';

test('backups must leave the box unless explicitly allowed for development', () => {
  for (const r of ['sftp:backup@nas.acme.lan:/srv/restic', 'rest:https://nas:8000/acme', 's3:https://s3.eu-west-2.amazonaws.com/acme-backups', 'b2:acme-backups:/hf'])
    expect(() => { assertOffBox(r, false); }, r).not.toThrow();
  for (const r of ['/state/restic', 'local:/backups', 'relative/path']) {
    expect(() => { assertOffBox(r, false); }, r).toThrow(/points at this box/);
    expect(() => { assertOffBox(r, true); }, r).not.toThrow();
  }
});

test('credentials never appear when a destination is described', () => {
  expect(describeRepo('rest:https://user:secret@nas:8000/acme')).toBe('rest:https://nas:8000/acme');
  expect(describeRepo('sftp:backup@nas.acme.lan:/srv/restic')).toBe('sftp:backup@nas.acme.lan:/srv/restic');
});

test('a loopback address is this box too', () => {
  for (const r of ['rest:http://localhost:8000/x', 'rest:http://127.0.0.1:8000/x', 'sftp:b@127.0.0.1:/r', 'rest:http://[::1]:8000/x'])
    expect(() => { assertOffBox(r, false); }, r).toThrow(/points at this box/);
  expect(() => { assertOffBox('rest:http://host.docker.internal:8000/x', false); }).not.toThrow();
});

test('the tunnel address must sit inside the edge network, and not on its network, gateway or broadcast address', () => {
  expect(checkEdgePair('172.30.250.10', '172.30.250.0/28')).toEqual([]);
  expect(checkEdgePair('10.9.0.2', '10.9.0.0/24')).toEqual([]);
  const outside = checkEdgePair('172.30.251.10', '172.30.250.0/28');
  expect(outside).toHaveLength(1);
  expect(outside[0]).toMatch(/^TUNNEL_IP \(172\.30\.251\.10\) is not inside EDGE_SUBNET \(172\.30\.250\.0\/28\)\..*Change both together/);
  expect(checkEdgePair('172.30.250.0', '172.30.250.0/28')[0]).toMatch(/network's own address/);
  expect(checkEdgePair('172.30.250.1', '172.30.250.0/28')[0]).toMatch(/gateway/);
  expect(checkEdgePair('172.30.250.15', '172.30.250.0/28')[0]).toMatch(/broadcast/);
  expect(checkEdgePair('172.30.250.300', '172.30.250.0/28')[0]).toMatch(/^TUNNEL_IP must be an address like 172\.30\.250\.10/);
  expect(checkEdgePair('172.30.250.10', '172.30.250.0')[0]).toMatch(/^EDGE_SUBNET must be a network like 172\.30\.250\.0\/28/);
  expect(checkEdgePair('172.30.250.10', '172.30.250.0/31')[0]).toMatch(/too small/);
  // A subnet written with host bits set is still read as its network.
  expect(checkEdgePair('172.30.250.10', '172.30.250.5/28')).toEqual([]);
});

const good = {
  INSTANCE_MODE: 'production', DATABASE_URL: 'postgres://app:dbpw@db:5432/app', APP_INTERNAL_URL: 'http://app:3000',
  CLIENT_LABEL: 'Acme Ltd', BACKUP_REPOSITORY: 'sftp:backup@nas.acme.lan:/srv/restic', BACKUP_PASSWORD: 'a-long-random-backup-password-xyz',
};

test('loadOpsConfig reads the Compose settings with the documented defaults', () => {
  const cfg = loadOpsConfig({ ...good, AWS_ACCESS_KEY_ID: 'AKIA1', AWS_SECRET_ACCESS_KEY: '', TUNNEL_ENABLED: 'true' });
  expect(cfg).toMatchObject({
    instanceMode: 'production', client: 'Acme Ltd', composeProject: 'highland', workDir: '/state/work', uploadsDir: '/data/uploads',
    auditRetentionDays: 730, tunnelEnabled: true,
    backup: { allowLocal: false, schedule: '30 2 * * *', restoreTestSchedule: '30 4 * * 0', keep: ['--keep-daily', '7', '--keep-weekly', '5', '--keep-monthly', '12'], backendEnv: { AWS_ACCESS_KEY_ID: 'AKIA1' } },
  });
});

test('a mismatched tunnel address and edge network is a warning for ops, never a reason to stop backups', () => {
  const cfg = loadOpsConfig({ ...good, TUNNEL_IP: '172.31.0.10', EDGE_SUBNET: '172.30.250.0/28' });
  expect(cfg.warnings).toHaveLength(1);
  expect(cfg.warnings[0]).toMatch(/^TUNNEL_IP \(172\.31\.0\.10\) is not inside EDGE_SUBNET \(172\.30\.250\.0\/28\)/);
  expect(loadOpsConfig(good).warnings).toEqual([]);
});

test('no part of a password in a destination address is ever shown, even with @, : or / in it', () => {
  for (const [repo, shown] of [
    ['rest:https://u:p@ss@nas:8000/x', 'rest:https://nas:8000/x'],
    ['rest:https://u:p/ss:w@nas/x', 'rest:https://nas/x'],
    ['s3:https://AKIA:se@cr/et@s3.example.com/bucket', 's3:https://s3.example.com/bucket'],
    ['sftp:backup:hunter2@nas:/srv', 'sftp:nas:/srv'],
    ['rest:https://justuser@nas/x', 'rest:https://justuser@nas/x'],
  ] as const) {
    expect(describeRepo(repo), repo).toBe(shown);
  }
  expect(repoPassword('rest:https://u:p@ss@nas:8000/x')).toBe('p@ss');
  expect(repoPassword('sftp:backup@nas:/srv')).toBeUndefined();
});

test('settings problems are listed one per line and never repeat a secret', () => {
  let err: OpsConfigError | undefined;
  try {
    loadOpsConfig({
      INSTANCE_MODE: 'live', DATABASE_URL: 'mysql://u:dbsecret@x/y', BACKUP_REPOSITORY: '/srv/backups', BACKUP_PASSWORD: 'short-secret',
      BACKUP_SCHEDULE: 'every night', BACKUP_KEEP: '--keep-daily 7 --password-command=evil', AUDIT_RETENTION_DAYS: 'lots', BACKUP_ALLOW_LOCAL: 'yes',
    });
  } catch (e) { err = e as OpsConfigError; }
  expect(err).toBeInstanceOf(OpsConfigError);
  const text = err!.message;
  expect(text).not.toContain('dbsecret');
  expect(text).not.toContain('short-secret');
  expect(err!.problems).toEqual(expect.arrayContaining([
    'INSTANCE_MODE must be one of demo, production, test (got "live").',
    'DATABASE_URL must be a database address starting with postgres:// (the value is hidden here for safety).',
    'APP_INTERNAL_URL is missing.',
    'CLIENT_LABEL is missing.',
    'BACKUP_PASSWORD must be at least 16 characters.',
    'BACKUP_ALLOW_LOCAL must be true or false (got "yes").',
    'BACKUP_SCHEDULE must be a cron schedule such as 30 2 * * * (got "every night").',
    'AUDIT_RETENTION_DAYS must be a whole number of days, 1 or more (got "lots").',
  ]));
  expect(err!.problems.some((p) => p.startsWith('BACKUP_KEEP may only hold restic --keep-… options'))).toBe(true);
  expect(err!.problems.some((p) => /BACKUP_REPOSITORY points at this box/.test(p))).toBe(true);
});
