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
  /** Consecutive failures before an alert (critical checks alert on the first), and consecutive passes before "Fixed". */
  failAfter?: number;
  remindEveryMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

interface State {
  fails: number;
  passes: number;
  since: Date | null;
  alertedAt: Date | null;
  alertedDetail: string;
  critical: boolean;
}

export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** Europe/London wall-clock time, HH:mm. */
export const ukTime = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

/**
 * The same problem with different numbers in it ("31 hours ago" an hour later, "0.2 GB free" then "0.1 GB free") is the
 * same problem; a different sentence is a new one.
 */
const sameProblem = (a: string, b: string): boolean => a.replace(/\d+(?:\.\d+)?/g, '#') === b.replace(/\d+(?:\.\d+)?/g, '#');

/**
 * Turns check results into alerts:
 * - a problem is alerted on its second consecutive failure, so a blip pages nobody (critical checks: on the first);
 * - it is repeated every 6 hours while it lasts, and a different problem on the same check is announced at once;
 * - "Fixed" is sent only after the same number of consecutive passes, so a flapping check does not cause a storm.
 * A check counts as alerted only once the channel accepted the message, so an alert that could not be sent is tried again
 * on the next tick; scheduler failures that could not be sent are retried on each tick too.
 *
 * The heartbeat is a dead-man's switch only: while ops is alive it always reports `up`, with a short summary as its message.
 * Problems go to the alert channel; reporting them as `down` would stop the outside watcher from noticing the box is off.
 * `tick()` never throws. State is in memory: after an ops restart a standing problem is announced again.
 */
export class Monitor {
  private readonly state = new Map<string, State>();
  private readonly pendingJobAlerts: { job: string; text: string }[] = [];
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
    // The heartbeat goes out alongside the alerts, never waiting behind a slow channel.
    const beat = this.heartbeat(results.filter((c) => !c.ok));
    const now = this.now();
    for (const c of results) {
      if (c.ok) await this.passed(c.name);
      else await this.failed(c, now);
    }
    await this.flushJobAlerts();
    await beat;
  }

  /** A scheduled job failed: alerted at once, with no two-strike rule. If it cannot be sent, it is retried on each tick. */
  async jobFailed(job: string, message: string): Promise<void> {
    const text = `[${this.opts.client}] Problem: the scheduled ${job} failed. ${message}`;
    try {
      await this.opts.channel.send(text);
    } catch (e) {
      this.log(`The alert about the failed scheduled ${job} could not be sent (it will be tried again at the next check): ${e instanceof Error ? e.message : 'unknown problem'}`);
      this.pendingJobAlerts.push({ job, text });
    }
  }

  private async flushJobAlerts(): Promise<void> {
    while (this.pendingJobAlerts.length > 0) {
      const next = this.pendingJobAlerts[0];
      if (next === undefined || !(await this.send(next.text))) return;
      this.pendingJobAlerts.shift();
    }
  }

  private async failed(c: Check, now: Date): Promise<void> {
    const st = this.state.get(c.name) ?? { fails: 0, passes: 0, since: null, alertedAt: null, alertedDetail: '', critical: false };
    this.state.set(c.name, st);
    st.fails++;
    st.passes = 0;
    st.since ??= now;
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
    if (!sameProblem(c.detail, st.alertedDetail)) {
      // Already over the two-strike line, so a different problem on the same check goes out at once.
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
    st.fails = 0;
    st.passes++;
    if (st.passes < this.failAfter) return;
    // Kept (with its alert) until the "fixed" message is accepted, so it is tried again next tick.
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

  private async heartbeat(failing: Check[]): Promise<void> {
    const url = this.opts.heartbeatUrl;
    if (url === undefined) return;
    const first = failing[0];
    const summary = first === undefined
      ? 'OK'
      : `${String(failing.length)} ${failing.length === 1 ? 'problem' : 'problems'}: ${first.detail}`.slice(0, 100);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${url}${url.includes('?') ? '&' : '?'}status=up&msg=${encodeURIComponent(summary)}`, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) this.log(`The outside watcher did not accept the heartbeat (HTTP ${String(res.status)}).`);
    } catch {
      // The address may hold a push token, so it is never logged.
      this.log('The heartbeat could not be sent to the outside watcher.');
    }
  }
}
