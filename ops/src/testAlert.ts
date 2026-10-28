import { alertSecrets, channelFromConfig, PARTIAL_ALERT, redactingChannel, type AlertChannel } from './alerts.js';
import type { OpsConfig } from './config.js';
import { USAGE } from './init-cli.js';
import { ukDate } from './time.js';

/**
 * Sends one plain test alert through `channel` (every configured channel, as the monitor uses them), so the operator can see
 * it arrive. Whether a real channel is set is read from the settings: with none (a demo or test box) it went to the log.
 */
export async function sendTestAlert(d: { cfg: Pick<OpsConfig, 'client' | 'instanceMode' | 'alerts'>; channel: AlertChannel; now: () => Date; log: (l: string) => void }): Promise<{ ok: boolean; message: string }> {
  const text = `[${d.cfg.client}] Test alert from ops on ${ukDate(d.now())}. Nothing is wrong; this only checks that alerts arrive.`;
  try {
    await d.channel.send(text);
  } catch (e) {
    return { ok: false, message: `The test alert could not be sent: ${e instanceof Error ? e.message : 'unknown problem'}` };
  }
  const configured = d.cfg.alerts.matrix !== undefined || d.cfg.alerts.webhookUrl !== undefined;
  if (!configured) return { ok: true, message: 'No alert channel is set, so the test alert went to the ops log only.' };
  return { ok: true, message: `Test alert sent to ${d.channel.name ?? 'the alert channel'}.` };
}

/** Where testAlertCli writes and how it reads the settings (cli.ts gives the real ones; tests give fakes). */
export interface TestAlertCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** The ops settings, or undefined when they cannot be read (the reason already said on standard error). */
  config: () => OpsConfig | undefined;
  now: () => Date;
}

/**
 * `ops test-alert`: exit 0 sent (to every channel), 1 not sent or not sent everywhere, 2 a usage or settings error. Runs in
 * the ops service: docker compose run --rm ops test-alert. Addresses and tokens are never printed.
 */
export async function testAlertCli(rest: string[], io: TestAlertCliIo): Promise<number> {
  if (rest.length > 0) { io.err(`test-alert takes no options.\n\n${USAGE}`); return 2; }
  const cfg = io.config();
  if (cfg === undefined) return 2;
  // allChannels logs a channel that failed while another worked; the test alert counts that as not sent everywhere.
  const seen = { partial: false };
  const log = (line: string): void => {
    if (line.startsWith(PARTIAL_ALERT)) { seen.partial = true; io.err(line); } else io.out(line);
  };
  const r = await sendTestAlert({ cfg, channel: redactingChannel(channelFromConfig(cfg, log), alertSecrets(cfg)), now: io.now, log });
  if (!r.ok) { io.err(r.message); return 1; }
  if (seen.partial) { io.err('The test alert reached some alert channels but not all (see above).'); return 1; }
  io.out(r.message);
  return 0;
}
