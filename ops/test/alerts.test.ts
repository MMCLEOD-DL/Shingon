import { test, expect } from 'vitest';
import { allChannels, alertSecrets, channelFromConfig, logChannel, matrixChannel, redactAlert, redactingChannel, webhookChannel } from '../src/alerts.js';
import { loadOpsConfig } from '../src/config.js';
import { withServer } from './helpers.js';

const errorOf = (p: Promise<void>): Promise<Error> => p.then(() => new Error('(no error)'), (x: unknown) => x as Error);

test('Matrix: the right room, the token in the header only, plain text body', async () => {
  await withServer(200, async (base, seen) => {
    await matrixChannel({ homeserver: base, accessToken: 'syt_secret_123', roomId: '!abc:highlandautomations.com' }).send('[Acme] Problem: x');
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url).toMatch(/^\/_matrix\/client\/v3\/rooms\/!abc%3Ahighlandautomations\.com\/send\/m\.room\.message\/hf-/);
    expect(seen[0]!.url).not.toContain('syt_secret_123');
    expect(seen[0]!.auth).toBe('Bearer syt_secret_123');
    expect(seen[0]!.body).toEqual({ msgtype: 'm.text', body: '[Acme] Problem: x' });
  });
});

test('a Matrix error never repeats the token', async () => {
  await withServer(403, async (base) => {
    const e = await errorOf(matrixChannel({ homeserver: base, accessToken: 'syt_secret_123', roomId: '!r:x' }).send('t'));
    expect(e.message).toBe('Matrix refused the alert (HTTP 403).');
    expect(e.message).not.toContain('syt_secret_123');
  });
});

test('each Matrix message gets its own transaction id, so a retry is never swallowed as a duplicate', async () => {
  await withServer(200, async (base, seen) => {
    const ch = matrixChannel({ homeserver: `${base}/`, accessToken: 'syt_secret_123', roomId: '!r:x' });
    await ch.send('a');
    await ch.send('a');
    expect(seen[0]!.url).not.toBe(seen[1]!.url);
    expect(seen[0]!.url.startsWith('/_matrix/')).toBe(true);
  });
});

test('a webhook gets JSON { text }; its errors never repeat the address, which may hold a secret', async () => {
  await withServer(200, async (base, seen) => {
    await webhookChannel(`${base}/hook?token=hook-secret-999`).send('[Acme] Problem: y');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/hook?token=hook-secret-999', body: { text: '[Acme] Problem: y' } });
  });
  await withServer(500, async (base) => {
    const e = await errorOf(webhookChannel(`${base}/hook?token=hook-secret-999`).send('x'));
    expect(e.message).toBe('The alert webhook refused the alert (HTTP 500).');
  });
  const closed = await errorOf(webhookChannel('http://127.0.0.1:1/hook?token=hook-secret-999').send('x'));
  expect(closed.message).toBe('The alert webhook could not be reached.');
  expect(closed.message).not.toContain('hook-secret-999');
});

test('configured channels are used even in demo mode; the log is only the fallback', async () => {
  await withServer(200, async (base, seen) => {
    const logged: string[] = [];
    await channelFromConfig({ instanceMode: 'demo', alerts: { webhookUrl: `${base}/hook` } }, (l) => logged.push(l)).send('[Demo] Problem: The app is not answering.');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toEqual({ text: '[Demo] Problem: The app is not answering.' });
    expect(logged).toEqual([]);
  });
  const logged: string[] = [];
  await channelFromConfig({ instanceMode: 'demo', alerts: {} }, (l) => logged.push(l)).send('[Demo] Problem: x');
  expect(logged).toEqual(['ALERT [Demo] Problem: x']);
});

test('with Matrix and a webhook both set, both get every alert, in production too', async () => {
  await withServer(200, async (mBase, mSeen) => {
    await withServer(200, async (wBase, wSeen) => {
      const logged: string[] = [];
      await channelFromConfig({ instanceMode: 'production', alerts: { matrix: { homeserver: mBase, accessToken: 'syt_x_1234', roomId: '!r:x' }, webhookUrl: `${wBase}/h` } }, (l) => logged.push(l)).send('hello');
      expect(mSeen).toHaveLength(1);
      expect(wSeen).toHaveLength(1);
      expect(logged).toEqual([]);
    });
  });
});

test('allChannels fails only when every channel fails', async () => {
  const sent: string[] = [];
  const ok = { send: async (t: string) => { sent.push(t); } };
  const bad = { send: () => Promise.reject(new Error('Matrix refused the alert (HTTP 500).')) };
  await allChannels([bad, ok]).send('one');
  expect(sent).toEqual(['one']);
  await expect(allChannels([bad, bad]).send('two')).rejects.toThrow('No alert could be sent: Matrix refused the alert (HTTP 500).');
});

test('logChannel writes ALERT lines', async () => {
  const logged: string[] = [];
  await logChannel((l) => logged.push(l)).send('x');
  expect(logged).toEqual(['ALERT x']);
});

test('alert text never carries a secret: tokens, passwords, webhook query secrets and database addresses are hidden', async () => {
  const cfg = loadOpsConfig({
    INSTANCE_MODE: 'production', DATABASE_URL: 'postgres://app:db-pass-4242@db:5432/app', APP_INTERNAL_URL: 'http://app:3000', CLIENT_LABEL: 'Acme',
    BACKUP_REPOSITORY: 'rest:https://restuser:repo-pass-777@nas:8000/acme', BACKUP_PASSWORD: 'backup-password-0123456789', HEALTH_TOKEN: 'health-token-abcdefghijklmnop',
    MATRIX_HOMESERVER: 'https://matrix.example', MATRIX_ACCESS_TOKEN: 'syt_matrix_secret_55', MATRIX_ROOM_ID: '!r:example',
    ALERT_WEBHOOK_URL: 'https://hooks.example/notify?key=webhook-key-31337&channel=ops', HEARTBEAT_URL: 'https://kuma.example/api/push/kumaPushToken42',
    RESTIC_REST_PASSWORD: 'rest-env-pass-88',
  });
  const secrets = alertSecrets(cfg);
  const nasty = 'Problem: syt_matrix_secret_55 backup-password-0123456789 health-token-abcdefghijklmnop postgres://app:db-pass-4242@db:5432/app '
    + 'db-pass-4242 repo-pass-777 webhook-key-31337 https://hooks.example/notify?key=webhook-key-31337&channel=ops kumaPushToken42 rest-env-pass-88 '
    + 'postgresql://other:zzz-other-pw@elsewhere/db https://u:inline-pw-1@x.example/y';
  const out = redactAlert(nasty, secrets);
  for (const s of ['syt_matrix_secret_55', 'backup-password-0123456789', 'health-token-abcdefghijklmnop', 'db-pass-4242', 'repo-pass-777', 'webhook-key-31337', 'kumaPushToken42', 'rest-env-pass-88', 'zzz-other-pw', 'inline-pw-1', 'postgres://app']) {
    expect(out, s).not.toContain(s);
  }
  expect(out).toContain('[hidden]');
  expect(out.startsWith('Problem: ')).toBe(true);

  const got: string[] = [];
  await redactingChannel({ send: async (t) => { got.push(t); } }, secrets).send('[Acme] Problem: the scheduled backup failed. syt_matrix_secret_55');
  expect(got).toEqual(['[Acme] Problem: the scheduled backup failed. [hidden]']);
});
