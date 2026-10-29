/**
 * Sends a money report as a download. The report is already built (buildMoneyReport, Ruling 4), so this only lays it
 * out and sets the headers. Call it from a route declared with defineRoute whose rows were read through visibleTo,
 * and register that route only when the export module is on (moduleOn, Ruling 7). As a second line of defence it
 * answers 404 when the module for the asked-for format is off.
 */
import type { FastifyReply } from 'fastify';
import { moduleOn, type AppProfile, type MoneyReport } from '@hf/shared';
import { renderPdf } from '@hf/pdf-export';
import { renderXlsx } from '@hf/xlsx-export';
import { encodeName } from '../../files/routes.js';
import { notFound } from '../../http/errors.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** The longest download name, in characters, extension included. */
const MAX_NAME = 120;

/** A file name without control characters, direction overrides or path separators, at most 120 characters; never empty. */
function downloadName(baseName: string, ext: string): string {
  const cleaned = baseName.replace(/\p{Cs}/gu, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  const base = Array.from(cleaned).slice(0, MAX_NAME - ext.length - 1).join('').trim();
  return `${base === '' ? 'report' : base}.${ext}`;
}

/** The export still being made; the next one waits for it. */
let lastExport: Promise<unknown> = Promise.resolve();

/**
 * Runs `make` once every export started before it has finished (or failed), so only one report file is built at a time
 * and a burst of downloads cannot exhaust a small box's memory.
 */
export function oneExportAtATime<T>(make: () => Promise<T>): Promise<T> {
  const turn = lastExport.then(make, make);
  lastExport = turn.catch(() => undefined);
  return turn;
}

export async function sendReport(
  reply: FastifyReply, config: { profile: AppProfile }, report: MoneyReport, format: 'pdf' | 'xlsx', baseName: string,
): Promise<void> {
  if (!moduleOn(config, format === 'xlsx' ? 'xlsx-export' : 'pdf-export')) throw notFound();
  const type = format === 'xlsx' ? XLSX_TYPE : 'application/pdf';
  const body = await oneExportAtATime(() => (format === 'xlsx' ? renderXlsx(report) : renderPdf(report)));
  // Built in full before any header is set, so a failure is an ordinary plain error, never half a download.
  await reply
    .header('content-type', type)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .header('content-length', body.length)
    .header('content-disposition', `attachment; filename*=UTF-8''${encodeName(downloadName(baseName, format))}`)
    .send(body);
}
