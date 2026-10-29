import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { emailOutbox } from '../db/schema/index.js';
import { renderTemplate, type Site, type TemplateName } from './templates.js';
import type { EmailTransport } from './transport.js';

/** Waits before retry 1..5. A sixth failure marks the mail as failed. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000] as const;

export async function queueEmail(tx: Db | Tx, m: { to: string; template: TemplateName; data: Record<string, string> }): Promise<void> {
  await tx.insert(emailOutbox).values({ toAddress: m.to, template: m.template, data: m.data, nextAttemptAt: new Date() });
}

type Row = { id: string; to_address: string; template: TemplateName; data: Record<string, string>; attempts: number };

export async function processOutbox(
  db: Db,
  transport: EmailTransport,
  site: Site & { from?: string },
  opts: { now?: Date; batch?: number; from?: string } = {},
): Promise<{ sent: number; retried: number; failed: number }> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 20;
  // The app always passes EMAIL_FROM (loadConfig requires it), so the noreply@ fallback is never used by the running app.
  // It is kept only for direct callers (tests, a future script) that give no sender, so they still produce a valid address.
  const from = opts.from ?? site.from ?? `${site.appName} <noreply@${new URL(site.appOrigin).hostname}>`;
  const counts = { sent: 0, retried: 0, failed: 0 };
  // One row per transaction: a bookkeeping failure cannot roll back (and so re-send) other mails,
  // and no lock is held across a whole batch.
  for (let i = 0; i < batch; i++) {
    const outcome = await db.transaction(async (tx): Promise<'sent' | 'retried' | 'failed' | null> => {
      const r = ((await tx.execute(sql`
        select id, to_address, template, data, attempts from email_outbox
        where status = 'pending' and next_attempt_at <= ${now}
        order by created_at, id limit 1 for update skip locked`)).rows as unknown as Row[])[0];
      if (!r) return null;
      try {
        const mail = renderTemplate(r.template, r.data, site);
        await transport.send({ to: r.to_address, from, ...mail });
        await tx.execute(sql`update email_outbox set status = 'sent', sent_at = ${now}, data = '{}'::jsonb, last_error = null where id = ${r.id}`);
        return 'sent';
      } catch (e) {
        const attempts = r.attempts + 1;
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        if (attempts > RETRY_DELAYS_MS.length) {
          await tx.execute(sql`update email_outbox set status = 'failed', attempts = ${attempts}, last_error = ${message}, data = '{}'::jsonb where id = ${r.id}`);
          return 'failed';
        }
        const next = new Date(now.getTime() + (RETRY_DELAYS_MS[attempts - 1] ?? 0));
        await tx.execute(sql`update email_outbox set attempts = ${attempts}, last_error = ${message}, next_attempt_at = ${next} where id = ${r.id}`);
        return 'retried';
      }
    });
    if (outcome === null) break;
    counts[outcome]++;
  }
  return counts;
}

export interface WorkerLog { error(obj: object, msg: string): void }

export function startOutboxWorker(
  db: Db,
  transport: EmailTransport,
  site: Site & { from?: string },
  opts: { intervalMs?: number; log?: WorkerLog; /** @internal Tests only; production must not pass this. Replaces the real processor so a test need not wait on database timing. */ process?: () => Promise<unknown> } = {},
): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = (opts.process ? opts.process() : processOutbox(db, transport, site))
      .catch((e: unknown) => {
        // Only the error name: messages can carry addresses or connection details.
        opts.log?.error({ errName: e instanceof Error ? e.name : 'Error' }, 'Email outbox run failed');
      })
      .finally(() => { running = null; });
  }, opts.intervalMs ?? 5000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
