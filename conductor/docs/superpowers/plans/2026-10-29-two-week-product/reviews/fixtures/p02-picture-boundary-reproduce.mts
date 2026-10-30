// Standalone P02 picture-detection boundary control; real local engine and PDF.js.
// Exit 1 means a parser-confirmed inline picture leaves a fully confident, unwarned amount.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
const ocr = resolve(process.argv[2] ?? 'foundation/modules/ocr');
const load = (file: string) => import(pathToFileURL(resolve(ocr, file)).href);
const { createLocalEngine } = await load('src/local.ts');
const { readReceipt } = await load('src/readReceipt.ts');
const { pdfOf } = await load('test/helpers.ts');
const { getDocument, OPS } = await import(pathToFileURL(resolve('foundation/node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
function inlinePdf(padding: number, compressed: boolean): Buffer {
  const content = Buffer.from(`q 10 0 0 10 10 780 cm BI${' '.repeat(padding + 1)}/W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q BT /F1 12 Tf 10 760 Td (Total GBP 10.00) Tj ET`, 'latin1');
  const data = compressed ? deflateSync(content) : content;
  return pdfOf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    Buffer.concat([Buffer.from(`<< /Length ${data.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream')]),
  ]);
}
const engine = await createLocalEngine();
try {
  for (const [padding, compressed] of [[0, false], [5000, false], [5000, true]] as const) {
    const bytes = inlinePdf(padding, compressed);
    // Independently require the renderer's actual paint operation, not just a BI-looking string.
    const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, standardFontDataUrl: resolve('foundation/node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/' });
    const document = await loading.promise;
    let imagePaints = 0;
    try {
      const operations = await (await document.getPage(1)).getOperatorList();
      imagePaints = operations.fnArray.filter((op: number) => op === OPS.paintInlineImageXObject || op === OPS.paintImageXObject).length;
      assert.equal(imagePaints, 1);
    } finally { await loading.destroy(); }
    const result = await engine.read({ bytes, type: 'application/pdf' });
    const proposal = readReceipt(result, '2026-10-30');
    assert.equal(proposal.amountPence?.value, 1000);
    const unsafe = proposal.amountPence.confidence === 1 && proposal.warnings.length === 0;
    if (padding === 0) {
      assert.equal(unsafe, false);
      assert.equal(proposal.amountPence.confidence, 0.6);
      assert.ok(proposal.warnings.some((warning: string) => warning.includes('picture')));
    }
    console.log(JSON.stringify({ padding, compressed, bytes: bytes.length, imagePaints, amountPence: proposal.amountPence, warnings: proposal.warnings, result: unsafe ? 'UNFLAGGED' : 'flagged' }));
    if (unsafe) process.exitCode = 1;
  }
} finally { await engine.close(); }
