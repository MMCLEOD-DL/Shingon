import { randomBytes } from 'node:crypto';
import { repoPassword, type OpsConfig } from './config.js';

/** Somewhere an alert can be sent. Rejects with a plain-English Error, never one that repeats an address or token. */
export interface AlertChannel {
  send(text: string): Promise<void>;
  /** How the channel is named in the ops log, such as "Matrix". Never an address or token. */
  name?: string;
}

/** An alert that gets no answer within this is counted as not sent, so a hung channel never stalls the monitor. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * Posts to a Matrix room as the alert bot (client-server API v3). The access token goes in the Authorization header only,
 * and errors name only the HTTP status. Each message has its own transaction id, so a retry is never taken for a duplicate.
 */
export function matrixChannel(cfg: { homeserver: string; accessToken: string; roomId: string; fetchImpl?: typeof fetch }): AlertChannel {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.homeserver.replace(/\/+$/, '');
  return {
    name: 'Matrix',
    async send(text) {
      const txn = `hf-${String(Date.now())}-${randomBytes(6).toString('hex')}`;
      const url = `${base}/_matrix/client/v3/rooms/${encodeURIComponent(cfg.roomId)}/send/m.room.message/${txn}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'PUT',
          headers: { authorization: `Bearer ${cfg.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'm.text', body: text }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        throw new Error('The Matrix server could not be reached.');
      }
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new Error(`Matrix refused the alert (HTTP ${String(res.status)}).`);
    },
  };
}

/** POSTs JSON `{ text }` to a web address (Slack-style incoming webhooks, n8n, a ticketing system). Errors never repeat the address. */
export function webhookChannel(url: string, fetchImpl?: typeof fetch): AlertChannel {
  const doFetch = fetchImpl ?? fetch;
  return {
    name: 'the alert webhook',
    async send(text) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        throw new Error('The alert webhook could not be reached.');
      }
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new Error(`The alert webhook refused the alert (HTTP ${String(res.status)}).`);
    },
  };
}

/** How allChannels starts the line it logs for a channel that failed while another succeeded. */
export const PARTIAL_ALERT = 'An alert went out, but not to';

/**
 * Sends to every channel at once. Rejects only if all of them fail, naming each failure. A channel that fails while another
 * succeeds is still logged (its name and plain error, never an address or token), so a broken route does not go unnoticed.
 */
export function allChannels(channels: AlertChannel[], log?: (line: string) => void): AlertChannel {
  return {
    name: 'every alert channel',
    async send(text) {
      const results = await Promise.allSettled(channels.map((c) => c.send(text)));
      const reasons = results.map((r) => (r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : 'unknown problem') : null));
      if (results.length > 0 && reasons.every((r) => r !== null)) {
        throw new Error(`No alert could be sent: ${[...new Set(reasons)].join(' ')}`);
      }
      reasons.forEach((r, i) => {
        if (r !== null) log?.(`${PARTIAL_ALERT} ${channels[i]?.name ?? 'one of the alert channels'}: ${r}`);
      });
    },
  };
}

/** Writes `ALERT <text>` to the ops log. The fallback for demo and test boxes with no channel set. */
export function logChannel(log: (line: string) => void): AlertChannel {
  return { send: (text) => { log(`ALERT ${text}`); return Promise.resolve(); } };
}

/**
 * The channel for these settings. Every configured channel is always used, in every mode. The log is used only when no
 * channel is set and the box is a demo or test box; a production box with none never gets here (loadOpsConfig refuses).
 */
export function channelFromConfig(cfg: Pick<OpsConfig, 'instanceMode' | 'alerts'>, log: (line: string) => void): AlertChannel {
  const channels: AlertChannel[] = [];
  if (cfg.alerts.matrix) channels.push(matrixChannel(cfg.alerts.matrix));
  if (cfg.alerts.webhookUrl !== undefined) channels.push(webhookChannel(cfg.alerts.webhookUrl));
  const [only, ...more] = channels;
  if (only !== undefined) return more.length === 0 ? only : allChannels(channels, log);
  if (cfg.instanceMode === 'demo' || cfg.instanceMode === 'test') return logChannel(log);
  // Defence in depth: loadOpsConfig already refuses this.
  return { send: () => Promise.reject(new Error('No alert channel is set. Set MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN and MATRIX_ROOM_ID, or ALERT_WEBHOOK_URL.')) };
}

/**
 * A path segment that may be a secret: 16 characters or more, or 8 or more mixing letters and digits (most push tokens and
 * hex or base64 ids). A plain word such as "database" or "notify" is not.
 */
export function looksLikeToken(seg: string): boolean {
  if (seg.length >= 16) return true;
  return seg.length >= 8 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg);
}

/** Every value from the settings that must never appear in an alert, longest first so a secret inside another is hidden whole. */
export function alertSecrets(cfg: Pick<OpsConfig, 'alerts' | 'heartbeatUrl' | 'healthToken' | 'databaseUrl' | 'backup'>): string[] {
  const out: string[] = [cfg.backup.password, ...Object.values(cfg.backup.backendEnv), cfg.databaseUrl];
  const inner = repoPassword(cfg.backup.repository);
  if (inner !== undefined) out.push(inner);
  if (cfg.healthToken !== undefined) out.push(cfg.healthToken);
  if (cfg.alerts.matrix) out.push(cfg.alerts.matrix.accessToken);
  for (const url of [cfg.databaseUrl, cfg.alerts.webhookUrl, cfg.heartbeatUrl]) {
    if (url === undefined || url === '') continue;
    out.push(url);
    try {
      const u = new URL(url);
      if (u.password !== '') out.push(u.password, decodeURIComponent(u.password));
      for (const v of u.searchParams.values()) out.push(v);
      // Push and webhook addresses often carry their secret in the path (…/api/push/<token>, …/hooks/<id>/<token>).
      // Only segments that look like a token are hidden, so ordinary words such as /webhook/database stay readable.
      if (url !== cfg.databaseUrl) for (const seg of u.pathname.split('/')) if (looksLikeToken(seg)) out.push(seg);
    } catch { /* not a URL: the whole value is already listed */ }
  }
  return [...new Set(out.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
}

/** Hides every listed secret, any database address, and the password part of any address in alert text. */
export function redactAlert(text: string, secrets: readonly string[]): string {
  let out = text;
  // Preserve whole configured-URL hiding before masking its password changes it.
  for (const s of secrets) if (s.includes('://')) out = out.split(s).join('[hidden]');
  // A literal secret can itself be "postgres" or "https". Recognize addresses
  // first, or substitution can break the scheme and leave credentials visible.
  out = out
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[database address hidden]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:***@');
  for (const s of secrets) out = out.split(s).join('[hidden]');
  return out;
}

/** Wraps a channel so nothing it sends can carry a secret from the settings. */
export function redactingChannel(channel: AlertChannel, secrets: readonly string[]): AlertChannel {
  return { ...(channel.name !== undefined ? { name: channel.name } : {}), send: (text) => channel.send(redactAlert(text, secrets)) };
}
