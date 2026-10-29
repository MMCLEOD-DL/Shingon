import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Mail { subject: string; text: string }

/**
 * The newest mail to this address, read from the folder the e2e app writes mail files to.
 * `after` is a Date.now() value taken before the action that sends the mail, so earlier mail is ignored.
 */
export async function latestMailTo(email: string, opts: { after?: number; timeoutMs?: number } = {}): Promise<Mail> {
  const dir = process.env['HF_E2E_MAIL_DIR'];
  if (!dir) throw new Error('HF_E2E_MAIL_DIR is not set.');
  const after = opts.after ?? 0;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const want = email.trim().toLowerCase();
  for (;;) {
    let best: { at: number; mail: Mail } | undefined;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const at = Number(/^(\d+)-/.exec(name)?.[1] ?? NaN); // files are named <ms since 1970>-<random>.json
      if (!name.endsWith('.json') || Number.isNaN(at) || at < after || (best && at < best.at)) continue;
      try {
        const m = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as { to?: unknown; subject?: unknown; text?: unknown };
        if (typeof m.to === 'string' && m.to.trim().toLowerCase() === want && typeof m.subject === 'string' && typeof m.text === 'string') {
          best = { at, mail: { subject: m.subject, text: m.text } };
        }
      } catch {
        // A file still being written: it is picked up on the next pass.
      }
    }
    if (best) return best.mail;
    if (Date.now() > deadline) throw new Error(`No mail to ${email} arrived in time.`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
