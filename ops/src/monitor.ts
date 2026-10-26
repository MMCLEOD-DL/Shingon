import type { AlertChannel } from './alerts.js';

/** One health check. `critical`: a standing problem with the settings, alerted on its first sighting and marked as critical. */
export interface Check { name: string; ok: boolean; detail: string; critical?: boolean }

export interface MonitorOptions {
  checks: () => Promise<Check[]>;
  channel: AlertChannel;
  /** The client's name, at the start of every alert. */
  client: string;
  /** Uptime Kuma push address, called on every tick. */
  heartbeatUrl?: string;
  /** Consecutive failures before an alert (critical checks alert on the first). */
  failAfter?: number;
  remindEveryMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

interface State { fails: number; since: Date | null; alertedAt: Date | null; alertedDetail: string; detail: string; critical: boolean }

export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** Europe/London wall-clock time, HH:mm. */
export const ukTime = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

/**
 * Turns check results into alerts: a problem is alerted on its second consecutive failure (so a blip pages nobody), repeated
 * every 6 hours while it lasts, and announced when it is fixed. A check counts as alerted only once the channel accepted the
 * message, so an alert that could not be sent is tried again on the next tick. Every tick also pings the heartbeat.
 * `tick()` never throws.
 */
export class Monitor {
  private readonly state = new Map<string, State>();
  private readonly failAfter: number;
  private readonly remindEveryMs: number;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: MonitorOptions) {
    this.failAfter = opts.failAfter ?? 2;
    this.remindEveryMs = opts.remindEveryMs ?? 6 * 3600e3;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => undefined);
  }

  async tick(): Promise<void> {
    let results: Check[];
    try {
      results = await this.opts.checks();
    } catch {
      results = [{ name: 'monitor', ok: false, detail: 'The health checks could not run.' }];
    }
    const now = this.now();
    for (const c of results) {
      if (c.ok) await this.passed(c.name);
      else await this.failed(c, now);
    }
    await this.heartbeat(results.find((c) => !c.ok));
  }

  /** A scheduled job failed: alerted at once, with no two-strike rule. Never throws; a send failure is logged. */
  async jobFailed(job: string, message: string): Promise<void> {
    try {
      await this.opts.channel.send(`[${this.opts.client}] Problem: the scheduled ${job} failed. ${message}`);
    } catch (e) {
      this.log(`The alert about the failed scheduled ${job} could not be sent: ${e instanceof Error ? e.message : 'unknown problem'}`);
    }
  }

  private async failed(c: Check, now: Date): Promise<void> {
    const st = this.state.get(c.name) ?? { fails: 0, since: null, alertedAt: null, alertedDetail: '', detail: c.detail, critical: c.critical === true };
    this.state.set(c.name, st);
    st.fails++;
    st.since ??= now;
    st.detail = c.detail;
    st.critical = c.critical === true;
    const label = st.critical ? 'Critical problem' : 'Problem';
    if (st.alertedAt === null) {
      if (st.fails < (st.critical ? 1 : this.failAfter)) return;
      if (await this.send(`[${this.opts.client}] ${label}: ${c.detail}`)) {
        st.alertedAt = now;
        st.alertedDetail = c.detail;
      }
      return;
    }
    if (now.getTime() - st.alertedAt.getTime() >= this.remindEveryMs) {
      const still = st.critical ? 'Still a critical problem' : 'Still a problem';
      if (await this.send(`[${this.opts.client}] ${still} since ${ukTime(st.since)}: ${c.detail}`)) st.alertedAt = now;
    }
  }

  private async passed(name: string): Promise<void> {
    const st = this.state.get(name);
    if (st === undefined) return;
    if (st.alertedAt === null) {
      this.state.delete(name);   // a blip that never alerted
      return;
    }
    // Kept (with its alert) until the "fixed" message is accepted, so it is tried again next tick.
    st.fails = 0;
    if (await this.send(`[${this.opts.client}] Fixed: ${st.alertedDetail} (now back to normal).`)) this.state.delete(name);
  }

  private async send(text: string): Promise<boolean> {
    try {
      await this.opts.channel.send(text);
      return true;
    } catch (e) {
      this.log(`An alert could not be sent (it will be tried again at the next check): ${e instanceof Error ? e.message : 'unknown problem'}`);
      return false;
    }
  }

  private async heartbeat(firstFailing: Check | undefined): Promise<void> {
    const url = this.opts.heartbeatUrl;
    if (url === undefined) return;
    const query = firstFailing === undefined ? 'status=up&msg=OK' : `status=down&msg=${encodeURIComponent(firstFailing.detail.slice(0, 100))}`;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${url}${url.includes('?') ? '&' : '?'}${query}`, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) this.log(`The outside watcher did not accept the heartbeat (HTTP ${String(res.status)}).`);
    } catch {
      // The address may hold a push token, so it is never logged.
      this.log('The heartbeat could not be sent to the outside watcher.');
    }
  }
}
