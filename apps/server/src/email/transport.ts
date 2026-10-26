import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface EmailMessage { to: string; from: string; subject: string; text: string; html: string }
export interface EmailTransport { send(m: EmailMessage): Promise<void> }

export function memoryTransport(): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, send(m) { sent.push(m); return Promise.resolve(); } };
}

export function createTransport(cfg: Config['email']): EmailTransport {
  if (cfg.transport === 'memory') return memoryTransport();
  if (cfg.transport === 'file') {
    const dir = cfg.fileDir;
    if (!dir) throw new Error('EMAIL_FILE_DIR is required for the file email transport.');
    return {
      async send(m) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${String(Date.now())}-${randomBytes(4).toString('hex')}.json`), JSON.stringify(m, null, 2));
      },
    };
  }
  const smtpUrl = cfg.smtpUrl;
  if (!smtpUrl) throw new Error('SMTP_URL is required for the smtp email transport.');
  const smtp = nodemailer.createTransport(smtpUrl);
  return {
    async send(m) {
      try {
        await smtp.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
      } catch (e) {
        // The outbox stores this message, so make sure the SMTP credentials cannot be in it.
        throw new Error(scrub(e instanceof Error ? e.message : String(e), smtpUrl));
      }
    },
  };
}

function scrub(message: string, smtpUrl: string): string {
  let out = message;
  try {
    const u = new URL(smtpUrl);
    for (const secret of [u.password, u.username, decodeURIComponent(u.password), decodeURIComponent(u.username)]) {
      if (secret) out = out.replaceAll(secret, '***');
    }
  } catch {
    out = out.replaceAll(smtpUrl, '***');
  }
  return out;
}
