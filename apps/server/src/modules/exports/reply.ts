/**
 * Sends a money report as a download. The report is already built (buildMoneyReport, Ruling 4), so this only lays it
 * out and sets the headers. Call it from a route declared with defineRoute whose rows were read through visibleTo,
 * and register that route only when the export module is on (moduleOn, Ruling 7).
 */
import type { FastifyReply } from 'fastify';
import type { MoneyReport } from '@hf/shared';
import { renderPdf } from '@hf/pdf-export';
import { renderXlsx } from '@hf/xlsx-export';
import { encodeName } from '../../files/routes.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** The longest download name, in characters, extension included. */
const MAX_NAME = 120;

/** A file name without control characters, direction overrides or path separators, at most 120 characters; never empty. */
function downloadName(baseName: string, ext: string): string {
  const cleaned = baseName.replace(/\p{Cs}/gu, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  const base = Array.from(cleaned).slice(0, MAX_NAME - ext.length - 1).join('').trim();
  return `${base === '' ? 'report' : base}.${ext}`;
}

export async function sendReport(reply: FastifyReply, report: MoneyReport, format: 'pdf' | 'xlsx', baseName: string): Promise<void> {
  let body: Buffer;
  let type: string;
  if (format === 'xlsx') {
    body = await renderXlsx(report);
    type = XLSX_TYPE;
  } else {
    body = await renderPdf(report);
    type = 'application/pdf';
  }
  // Built in full before any header is set, so a failure is an ordinary plain error, never half a download.
  await reply
    .header('content-type', type)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .header('content-length', body.length)
    .header('content-disposition', `attachment; filename*=UTF-8''${encodeName(downloadName(baseName, format))}`)
    .send(body);
}
