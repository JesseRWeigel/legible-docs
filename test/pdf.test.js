import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { extractPdf, pdfToHTML, tokenize, runContentStream, detectColumns, parseObjects, decodeStream } from '../src/pdf/extract.js';
import { auditDocument } from '../src/audit.js';
import { readGroundTruth } from '../src/readingorder.js';
import { remediateHTML } from '../src/remediate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(HERE, '..', 'corpus', 'public-notice.pdf');
const buffer = () => fs.readFileSync(PDF);
const order = () => readGroundTruth(fs.readFileSync(path.join(HERE, '..', 'corpus', 'public-notice.order.txt'), 'utf8'));

test('the tokenizer reads strings, numbers, names and operators', () => {
  const t = tokenize(Buffer.from('BT /F1 12 Tf 0.63 g 1 0 0 1 54 720 Tm (Hello \\(there\\)) Tj ET', 'latin1'));
  const ops = t.filter((x) => x.type === 'op').map((x) => x.value);
  assert.deepEqual(ops, ['BT', 'Tf', 'g', 'Tm', 'Tj', 'ET']);
  const strings = t.filter((x) => x.type === 'string').map((x) => x.value);
  assert.deepEqual(strings, ['Hello (there)'], 'escaped parentheses must survive');
});

test('octal escapes and hex strings decode', () => {
  assert.equal(tokenize(Buffer.from('(\\101\\102) Tj')).find((t) => t.type === 'string').value, 'AB');
  assert.equal(tokenize(Buffer.from('<4142> Tj')).find((t) => t.type === 'string').value, 'AB');
});

test('grey, rgb and cmyk fills all become a measurable colour', () => {
  const run = (src) => runContentStream(Buffer.from(src, 'latin1'), [0, 0, 612, 792]).runs[0];
  assert.equal(run('BT /F1 12 Tf 0 g 1 0 0 1 10 10 Tm (x) Tj ET').color, '#000000');
  assert.equal(run('BT /F1 12 Tf 1 g 1 0 0 1 10 10 Tm (x) Tj ET').color, '#ffffff');
  assert.equal(run('BT /F1 12 Tf 0.63 g 1 0 0 1 10 10 Tm (x) Tj ET').color, '#a1a1a1');
  assert.equal(run('BT /F1 12 Tf 1 0 0 rg 1 0 0 1 10 10 Tm (x) Tj ET').color, '#ff0000');
  // CMYK 0,0,0,1 is black; 0,0,0,0 is white.
  assert.equal(run('BT /F1 12 Tf 0 0 0 1 k 1 0 0 1 10 10 Tm (x) Tj ET').color, '#000000');
  assert.equal(run('BT /F1 12 Tf 0 0 0 0 k 1 0 0 1 10 10 Tm (x) Tj ET').color, '#ffffff');
});

test('a full page background rectangle is picked up, a small one is not', () => {
  const big = runContentStream(Buffer.from('0.9 g 0 0 612 792 re f BT /F1 12 Tf 0 g 1 0 0 1 10 10 Tm (x) Tj ET', 'latin1'), [0, 0, 612, 792]);
  assert.equal(big.background, '#e6e6e6');
  const small = runContentStream(Buffer.from('0.9 g 0 0 50 50 re f BT /F1 12 Tf 0 g 1 0 0 1 10 10 Tm (x) Tj ET', 'latin1'), [0, 0, 612, 792]);
  assert.equal(small.background, '#ffffff', 'a small box is not the page background');
});

test('text position comes from the text matrix', () => {
  const { runs } = runContentStream(Buffer.from('BT /F1 9 Tf 1 0 0 1 324 696 Tm (right column) Tj ET', 'latin1'), [0, 0, 612, 792]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].x, 324);
  assert.equal(runs[0].y, 696);
  assert.equal(runs[0].fontSizePt, 9);
});

test('an unsupported stream filter is an error, not silently empty text', () => {
  // Returning no text for a stream this reader cannot decode would look exactly like a page
  // with no text on it, and the audit would report a clean document.
  const obj = { num: 7, dict: { Filter: '/LZWDecode' }, stream: Buffer.from('anything') };
  assert.throws(() => decodeStream(obj), /unsupported stream filter/);
  const broken = { num: 8, dict: { Filter: '/FlateDecode' }, stream: Buffer.from('not deflate data') };
  assert.throws(() => decodeStream(broken), /did not inflate/);
});

test('objects and their streams are found in the corpus PDF', () => {
  const objects = parseObjects(buffer());
  assert.ok(objects.size >= 5, `found only ${objects.size} objects`);
  const page = [...objects.values()].find((o) => /\/Type\s*\/Page\b/.test(o.header));
  assert.ok(page, 'no page object');
  const content = [...objects.values()].find((o) => o.stream && (o.dict.Filter || '').includes('FlateDecode'));
  assert.ok(content, 'no compressed content stream');
  assert.match(zlib.inflateSync(content.stream).toString('latin1'), /CITY OF RIVERTON/);
});

test('the corpus PDF has the accessibility faults it was built to have', () => {
  const x = extractPdf(buffer());
  assert.equal(x.pages.length, 1);
  assert.equal(x.tagged, false, 'no tagged structure, so there is no author reading order');
  assert.equal(x.lang, null, 'no /Lang');
  assert.equal(x.imageOnlyPages, 0);
  const page = x.pages[0];
  assert.ok(page.textRuns > 20, `only ${page.textRuns} runs extracted`);
  assert.equal(page.columns.length, 2, 'the two column layout must be detected');
  // The content stream alternates left line, right line, so a linearising reader interleaves
  // the two stories. This is the number that proves the defect is present and measurable.
  assert.ok(page.streamOrderInversions > 0,
    'stream order and reading order must disagree, otherwise the fixture is not testing anything');
  assert.equal(page.streamOrderPairs, (page.textRuns * (page.textRuns - 1)) / 2);
});

test('column detection needs a real gap and two populated sides', () => {
  const mb = [0, 0, 612, 792];
  const single = [{ x: 54, y: 700 }, { x: 54, y: 688 }, { x: 56, y: 676 }].map((r, i) => ({ ...r, streamIndex: i }));
  assert.equal(detectColumns(single, mb).length, 1);
  const two = [];
  for (let i = 0; i < 4; i += 1) { two.push({ x: 54, y: 700 - i * 12, streamIndex: i * 2 }); two.push({ x: 324, y: 700 - i * 12, streamIndex: i * 2 + 1 }); }
  assert.equal(detectColumns(two, mb).length, 2);
  // One stray run on the far side is not a column.
  const stray = [...single, { x: 500, y: 700, streamIndex: 9 }];
  assert.equal(detectColumns(stray, mb).length, 1);
});

test('reading order beats stream order against the hand written ground truth', () => {
  const x = extractPdf(buffer());
  const expected = order();
  const reading = auditDocument(pdfToHTML(x, 'notice.pdf', { order: 'reading' }), { expectedOrder: expected });
  const stream = auditDocument(pdfToHTML(x, 'notice.pdf', { order: 'stream' }), { expectedOrder: expected });

  assert.equal(reading.summary.readingOrder.missing, 0, 'every ground truth line must be found in the reflow');
  assert.equal(stream.summary.readingOrder.missing, 0);
  // The baseline is genuinely broken, and the column aware reflow genuinely fixes it. Without
  // the first assertion the second one proves nothing.
  assert.ok(stream.summary.readingOrder.inversions > 0,
    'the stream order baseline should be scrambled, otherwise there is nothing to fix');
  assert.equal(reading.summary.readingOrder.inversions, 0,
    `column aware reflow still has ${reading.summary.readingOrder.inversions} inverted pairs`);
});

test('the PDF text carries its real colours into the contrast measurement', () => {
  const html = pdfToHTML(extractPdf(buffer()), 'notice.pdf');
  const audit = auditDocument(html);
  assert.ok(audit.summary.failingContrast > 0, 'the 0.63 grey body text must fail');
  // 0.63 grey is #a1a1a1. On white that is 2.65:1, well under 4.5.
  assert.ok(audit.textRuns.some((r) => r.foreground === '#a1a1a1'), 'the body grey should survive extraction');
  assert.ok(audit.summary.minContrast < 3);
});

test('a PDF goes through the same remediation as an HTML document and comes out passing', () => {
  const html = pdfToHTML(extractPdf(buffer()), 'notice.pdf');
  const expected = order();
  const result = remediateHTML(html, { expectedOrder: expected });
  const after = auditDocument(result.html, { expectedOrder: expected });
  assert.equal(after.summary.failingContrast, 0);
  assert.ok(after.summary.minContrast >= 4.5);
  assert.equal(after.summary.readingOrder.inversions, 0);
  assert.equal(after.summary.justifiedRuns, 0);
});

test('a page with no extractable text says so instead of returning a clean document', () => {
  // A one page PDF whose only content is an image XObject. A reader that returned empty text
  // here would produce an HTML document with nothing in it, and every check would pass.
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 30 >>\nstream\nq 612 0 0 792 0 0 cm /Im0 Do Q\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 >>\nstream\nxxxx\nendstream\nendobj\n'
  ];
  const scanned = Buffer.from(`%PDF-1.4\n${objs.join('')}trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n`, 'latin1');
  const x = extractPdf(scanned);
  assert.equal(x.pages[0].textRuns, 0);
  assert.equal(x.pages[0].imageOnly, true);
  assert.equal(x.imageOnlyPages, 1);
  const html = pdfToHTML(x, 'scan.pdf');
  assert.match(html, /optical character recognition/);
  assert.match(html, /did not invent text/);
});

test('a file that is not a readable PDF fails loudly', () => {
  assert.throws(() => extractPdf(Buffer.from('this is not a pdf at all')), /may not be a PDF this tool can read/);
});
