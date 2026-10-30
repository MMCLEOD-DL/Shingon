// Run at repository root: foundation/node_modules/.bin/tsx <this file> [archived OCR directory]
// Exit 1 means ignored image evidence still leaves an unwarned, fully confident amount.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ocr = resolve(process.argv[2] ?? 'foundation/modules/ocr');
const load = (file: string) => import(pathToFileURL(resolve(ocr, file)).href);
const { createLocalEngine, imageSize } = await load('src/local.ts');
const { readReceipt } = await load('src/readReceipt.ts');
const jpeg = readFileSync(resolve(ocr, 'test/fixtures/receipts/rendered/taxi-photo.jpg'));
const expected = JSON.parse(readFileSync(resolve(ocr, 'test/fixtures/receipts/expected.json'), 'utf8'));
assert.equal(expected['taxi-photo.jpg'].amountPence, 1240);
const { width, height } = imageSize(jpeg);
const stream = (text: string) => `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`;
function pdf(footer: string | null, image = true): Buffer {
  const pictureContent = [image ? 'q 500 0 0 740 10 10 cm /Im0 Do Q' : '',
    footer === null ? '' : `BT /F1 10 Tf 10 780 Td (${footer}) Tj ET`].filter(Boolean).join('\n');
  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    stream('BT /F1 12 Tf 10 760 Td (Total GBP 10.00) Tj ET'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 8 0 R >> >> /Contents 7 0 R >>',
    stream(pictureContent),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'), jpeg, Buffer.from('\nendstream')]),
  ];
  let out = Buffer.from('%PDF-1.7\n', 'latin1');
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.from(o), Buffer.from('\nendobj\n', 'latin1')]);
    return at;
  });
  const entries = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.concat([out, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${out.length}\n%%EOF\n`, 'latin1')]);
}
const engine = await createLocalEngine();
try {
  for (const [name, bytes] of [
    ['image page without footer', pdf(null)],
    ['all-text control with non-painted image resource', pdf('Scanned with PhoneScan', false)],
    ['image page with non-amount scanner footer', pdf('Scanned with PhoneScan')],
  ] as const) {
    try {
      const result = await engine.read({ bytes, type: 'application/pdf' });
      const proposal = readReceipt(result, '2026-10-30');
      const unsafe = name === 'image page with non-amount scanner footer'
        && proposal.amountPence?.value === 1000 && proposal.amountPence.confidence === 1 && proposal.warnings.length === 0;
      if (name === 'all-text control with non-painted image resource') assert.equal(proposal.amountPence?.value, 1000);
      console.log(JSON.stringify({name, result: unsafe ? 'UNSAFE' : 'read', lines: result.lines, proposal}));
      if (unsafe) process.exitCode = 1;
    } catch (error) {
      if (error.name !== 'UnreadableError') throw error;
      console.log(JSON.stringify({name, result:'refused', message:error.userMessage}));
    }
  }
} finally {
  await engine.close();
}
