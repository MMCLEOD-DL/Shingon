// Run from the repository root with foundation/node_modules/.bin/tsx <this-file>.
// Optional argument: an archived OCR directory containing src/ and test/.
// Exit 1 means an incomplete PDF still produces an unwarned confident amount.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ocr = resolve(process.argv[2] ?? 'foundation/modules/ocr');
const load = (file: string) => import(pathToFileURL(resolve(ocr, file)).href);
const { createLocalEngine, imageSize } = await load('src/local.ts');
const { readReceipt } = await load('src/readReceipt.ts');
const { textPdf } = await load('test/helpers.ts');

// A valid two-page PDF: a text total followed by the repository's fictional
// photographed taxi receipt, whose known total is GBP 12.40 (expected.json).
function mixedPdf(): Buffer {
  const jpeg = readFileSync(resolve(ocr, 'test/fixtures/receipts/rendered/taxi-photo.jpg'));
  const { width, height } = imageSize(jpeg);
  const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    stream('BT /F1 12 Tf 10 760 Td (Total GBP 10.00) Tj ET'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im0 8 0 R >> >> /Contents 7 0 R >>',
    stream('q 500 0 0 740 10 10 cm /Im0 Do Q'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
  ];
  let out = Buffer.from('%PDF-1.7\n');
  const offsets = objects.map((object, i) => {
    const offset = out.length;
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    return offset;
  });
  const xref = out.length;
  const entries = offsets.map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.concat([out, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}

const engine = await createLocalEngine();
const read = (bytes: Buffer) => engine.read({ bytes, type: 'application/pdf' });
try {
  // Supported boundary controls must continue reading every text page.
  for (const count of [1, 3]) {
    const result = await read(textPdf(Array.from({ length: count }, (_, i) => [`Page ${i + 1}`])));
    assert.equal(result.lines.length, count);
    console.log(JSON.stringify({ controlPages: count, result: 'all pages read' }));
  }
  const pages = [['Total GBP 10.00'], ['page two'], ['page three'], ['Corrected final total GBP 100.00']];
  const ordinary = textPdf(pages);
  try {
    const result = await read(ordinary);
    console.log(JSON.stringify({ controlPages: 4, result: 'UNSAFE', proposal: readReceipt(result, '2026-10-29') }));
    process.exitCode = 1;
  } catch (error) {
    assert.equal(error.name, 'UnreadableError');
    console.log(JSON.stringify({ controlPages: 4, result: 'refused', message: error.userMessage }));
  }
  // Same-width substitution leaves the xref valid; only the page-tree count is false.
  const undercount = Buffer.from(ordinary.toString('latin1').replace('/Count 4', '/Count 3'), 'latin1');
  for (const [name, bytes] of [['mixed text and scanned page', mixedPdf()], ['understated page count', undercount]] as const) {
    try {
      const result = await read(bytes);
      const proposal = readReceipt(result, '2026-10-29');
      const unsafe = proposal.amountPence?.value === 1000 && proposal.amountPence.confidence === 1 && proposal.warnings.length === 0;
      console.log(JSON.stringify({ name, result: unsafe ? 'UNSAFE' : 'review changed result', lines: result.lines, proposal }));
      if (unsafe) process.exitCode = 1;
    } catch (error) {
      if (error.name !== 'UnreadableError') throw error;
      console.log(JSON.stringify({ name, result: 'refused', message: error.userMessage }));
    }
  }
} finally {
  await engine.close();
}
