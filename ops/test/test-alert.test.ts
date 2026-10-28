import { describe, expect, test } from 'vitest';
import { channelFromConfig, type AlertChannel } from '../src/alerts.js';
import { loadOpsConfig, type OpsConfig } from '../src/config.js';
import { sendTestAlert, testAlertCli, type TestAlertCliIo } from '../src/testAlert.js';
import { TEST_BACKUP_PASSWORD, withServer } from './helpers.js';

const TEN_AM = new Date('2026-10-27T10:00:00Z');
const TEXT = '[Acme] Test alert from ops on 27 October 2026 at 10:00. Nothing is wrong; this only checks that alerts arrive.';
const matrixCfg: Pick<OpsConfig, 'client' | 'instanceMode' | 'alerts'> = {
  client: 'Acme', instanceMode: 'production', alerts: { matrix: { homeserver: 'http://127.0.0.1:1', accessToken: 'syt_token', roomId: '!r:x' } },
};

function recording(name: string, fail?: string): AlertChannel & { sent: string[] } {
  const sent: string[] = [];
  return { name, sent, send: async (t) => { sent.push(t); if (fail !== undefined) throw new Error(fail); } };
}

describe('sendTestAlert', () => {
  test('a test alert goes out with the client name and says nothing is wrong', async () => {
    const ch = recording('Matrix');
    const logs: string[] = [];
    expect(await sendTestAlert({ cfg: matrixCfg, channel: ch, now: () => TEN_AM, log: (l) => logs.push(l) })).toEqual({ ok: true, message: 'Test alert sent to Matrix.' });
    expect(ch.sent).toEqual([TEXT]);
  });

  test('a channel that fails is reported plainly', async () => {
    const ch = recording('the alert webhook', 'The alert webhook refused the alert (HTTP 500).');
    expect(await sendTestAlert({ cfg: { ...matrixCfg, alerts: { webhookUrl: 'http://127.0.0.1:1/h' } }, channel: ch, now: () => TEN_AM, log: () => undefined }))
      .toEqual({ ok: false, message: 'The test alert could not be sent: The alert webhook refused the alert (HTTP 500).' });
  });

  test('a demo box with no channel says the alert only went to the log', async () => {
    const cfg: Pick<OpsConfig, 'client' | 'instanceMode' | 'alerts'> = { client: 'Acme', instanceMode: 'demo', alerts: {} };
    const logs: string[] = [];
    const r = await sendTestAlert({ cfg, channel: channelFromConfig(cfg, (l) => logs.push(l)), now: () => TEN_AM, log: (l) => logs.push(l) });
    expect(r).toEqual({ ok: true, message: 'No alert channel is set, so the test alert went to the ops log only.' });
    expect(logs).toEqual([`ALERT ${TEXT}`]);
  });
});

/** Real settings (loadOpsConfig) in demo mode; the alert catcher is a local server, never the real thing. */
function cliIo(env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const o: TestAlertCliIo = {
    out: (l) => { out.push(...l.split('\n')); },
    err: (l) => { err.push(...l.split('\n')); },
    config: () => loadOpsConfig({
      INSTANCE_MODE: 'demo', DATABASE_URL: 'postgres://app:dbpw-1234@127.0.0.1:1/app', APP_INTERNAL_URL: 'http://127.0.0.1:1', CLIENT_LABEL: 'Acme',
      BACKUP_REPOSITORY: 'sftp:backup@nas.test.lan:/srv/restic', BACKUP_PASSWORD: TEST_BACKUP_PASSWORD, ...env,
    }),
    now: () => TEN_AM,
  };
  return { o, out, err };
}

describe('ops test-alert', () => {
  test('through a webhook on the local catcher: sent, exit 0, and the secret part of the address is never printed', async () => {
    await withServer(200, async (base, seen) => {
      const hook = `${base}/hooks/n8n/a1b2c3d4e5f6a7b8c9d0`;
      const t = cliIo({ ALERT_WEBHOOK_URL: hook });
      expect(await testAlertCli([], t.o)).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).toEqual({ text: TEXT });
      expect(t.out).toEqual(['Test alert sent to the alert webhook.']);
      expect([...t.out, ...t.err].join('\n')).not.toMatch(/a1b2c3d4e5f6a7b8c9d0|127\.0\.0\.1/);
    });
  });

  test('a catcher that refuses: exit 1 with the plain reason on standard error', async () => {
    await withServer(500, async (base) => {
      const t = cliIo({ ALERT_WEBHOOK_URL: `${base}/hooks/a1b2c3d4e5f6a7b8c9d0` });
      expect(await testAlertCli([], t.o)).toBe(1);
      expect(t.err).toEqual(['The test alert could not be sent: The alert webhook refused the alert (HTTP 500).']);
      expect(t.out).toEqual([]);
    });
  });

  test('two channels where one fails: exit 1, naming the one that failed (never its address or token)', async () => {
    await withServer(200, async (good) => {
      await withServer(403, async (bad) => {
        const t = cliIo({ ALERT_WEBHOOK_URL: `${good}/hooks/a1b2c3d4e5f6a7b8c9d0`, MATRIX_HOMESERVER: bad, MATRIX_ACCESS_TOKEN: 'syt_secret_token_123', MATRIX_ROOM_ID: '!room:x' });
        expect(await testAlertCli([], t.o)).toBe(1);
        const all = [...t.out, ...t.err].join('\n');
        expect(all).toContain('An alert went out, but not to Matrix: Matrix refused the alert (HTTP 403).');
        expect(t.err).toContain('The test alert reached some alert channels but not all (see above).');
        expect(all).not.toMatch(/syt_secret_token_123|a1b2c3d4e5f6a7b8c9d0/);
      });
    });
  });

  test('a demo box with no channel: the alert goes to the log (standard output) and the message says so', async () => {
    const t = cliIo({});
    expect(await testAlertCli([], t.o)).toBe(0);
    expect(t.out).toEqual([`ALERT ${TEXT}`, 'No alert channel is set, so the test alert went to the ops log only.']);
  });

  test('options are refused; unreadable settings give exit 2', async () => {
    const t = cliIo({});
    expect(await testAlertCli(['--now'], t.o)).toBe(2);
    expect(t.err[0]).toBe('test-alert takes no options.');
    const bad = cliIo({});
    bad.o.config = () => undefined;
    expect(await testAlertCli([], bad.o)).toBe(2);
  });
});
