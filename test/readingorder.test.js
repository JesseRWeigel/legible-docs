import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from '../src/html/parse.js';
import {
  linearize, measureReadingOrder, readGroundTruth, countInversions, isLayoutTable,
  columnMajorCells, ownText, normalizeText
} from '../src/readingorder.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const corpus = (name) => fs.readFileSync(path.join(HERE, '..', 'corpus', name), 'utf8');

// Two stories side by side in a layout table. On screen a person reads the whole left column,
// then the whole right column. In the markup the rows interleave them.
const SIDE_BY_SIDE = `<html><body><table>
<tr><td><p>Left one.</p></td><td><p>Right one.</p></td></tr>
<tr><td><p>Left two.</p></td><td><p>Right two.</p></td></tr>
<tr><td><p>Left three.</p></td><td><p>Right three.</p></td></tr>
</table></body></html>`;

const VISUAL_ORDER = ['left one', 'left two', 'left three', 'right one', 'right two', 'right three'];

test('the tool notices when visual order and DOM order disagree', () => {
  const root = parseHTML(SIDE_BY_SIDE);
  const m = measureReadingOrder(root, VISUAL_ORDER);
  assert.equal(m.matched, 6, 'all six blocks found');
  assert.equal(m.missing.length, 0);
  assert.ok(m.inversions > 0, 'the interleaving must be detected, got 0 inversions');
  // Hand count. DOM positions of the six visual blocks, using the <p> elements in tree order
  // (L1=0, R1=1, L2=2, R2=3, L3=4, R3=5). Visual order gives positions [0, 2, 4, 1, 3, 5].
  // Inverted pairs: (2,1) (4,1) (4,3) = 3 of the 15 pairs.
  assert.equal(m.pairs, 15);
  assert.equal(m.inversions, 3);
  assert.equal(Number(m.tauDistance.toFixed(4)), Number((3 / 15).toFixed(4)));
});

test('a document whose visual order matches its DOM order scores zero', () => {
  const linear = `<html><body>
<p>Left one.</p><p>Left two.</p><p>Left three.</p>
<p>Right one.</p><p>Right two.</p><p>Right three.</p>
</body></html>`;
  const m = measureReadingOrder(parseHTML(linear), VISUAL_ORDER);
  assert.equal(m.matched, 6);
  assert.equal(m.inversions, 0, 'a correctly ordered document must not be flagged');
});

test('countInversions is exact on a known permutation', () => {
  assert.deepEqual(countInversions([0, 1, 2, 3]), { inversions: 0, pairs: 6 });
  assert.deepEqual(countInversions([3, 2, 1, 0]), { inversions: 6, pairs: 6 });
  assert.deepEqual(countInversions([0, 2, 1]), { inversions: 1, pairs: 3 });
  assert.deepEqual(countInversions([]), { inversions: 0, pairs: 0 });
});

test('a snippet that is not in the document is reported missing, not silently dropped', () => {
  const m = measureReadingOrder(parseHTML('<p>Only this.</p>'), ['only this', 'not here at all']);
  assert.equal(m.matched, 1);
  assert.deepEqual(m.missing, ['not here at all']);
});

test('each ground truth line consumes a distinct block', () => {
  // Two paragraphs with the same words must not both match the first block, which would hide
  // a real inversion behind an accidental self-match.
  const root = parseHTML('<p>the same line</p><p>the same line</p><p>different</p>');
  const m = measureReadingOrder(root, ['the same line', 'the same line', 'different']);
  assert.equal(m.matched, 3);
  assert.deepEqual(m.order, [0, 1, 2]);
});

test('a layout table is told apart from a data table', () => {
  const layout = parseHTML('<table><tr><td>a</td><td>b</td></tr></table>');
  assert.equal(isLayoutTable(layout.children[0]), true);
  const data = parseHTML('<table><tr><th scope="col">Day</th><th>Opens</th></tr><tr><td>Mon</td><td>9</td></tr></table>');
  assert.equal(isLayoutTable(data.children[0]), false, 'a table with headers carries meaning and must be left alone');
  const captioned = parseHTML('<table><caption>Hours</caption><tr><td>a</td><td>b</td></tr></table>');
  assert.equal(isLayoutTable(captioned.children[0]), false);
  const singleCol = parseHTML('<table><tr><td>only</td></tr></table>');
  assert.equal(isLayoutTable(singleCol.children[0]), false, 'one column cannot interleave anything');
  const declared = parseHTML('<table role="presentation"><tr><th>a</th><th>b</th></tr></table>');
  assert.equal(isLayoutTable(declared.children[0]), true, 'the author said so');
});

test('columnMajorCells reads down each column, which is what the eye does', () => {
  const root = parseHTML(SIDE_BY_SIDE);
  const table = root.children[0].children[0].children[0];
  const cells = columnMajorCells(table);
  assert.equal(cells.length, 6);
  const texts = cells.map((c) => normalizeText(c.children.map((x) => ownText(x)).join(' ')).trim());
  assert.deepEqual(texts, ['left one.', 'left two.', 'left three.', 'right one.', 'right two.', 'right three.']);
});

test('ownText stops at nested block elements', () => {
  const root = parseHTML('<div>outer <span>inline</span> <p>inner block</p> tail</div>');
  const div = root.children[0];
  assert.equal(normalizeText(ownText(div)), 'outer inline tail');
});

test('linearize skips empty and non-rendered elements', () => {
  const root = parseHTML('<head><title>T</title><style>p{color:red}</style></head><body><p></p><p>real</p></body>');
  const blocks = linearize(root);
  assert.deepEqual(blocks.map((b) => b.text), ['real'],
    'a title, a stylesheet, and an empty paragraph are not reading-order blocks');
});

test('readGroundTruth ignores comments and blank lines', () => {
  const parsed = readGroundTruth('# a comment\n\n  First Line  \n\n# another\nSecond line\n');
  assert.deepEqual(parsed, ['first line', 'second line']);
});

test('the corpus documents have the reading order defect their notes describe', () => {
  for (const [doc, order] of [['school-letter.html', 'school-letter.order.txt'],
    ['benefit-notice.html', 'benefit-notice.order.txt']]) {
    const m = measureReadingOrder(parseHTML(corpus(doc)), readGroundTruth(corpus(order)));
    assert.equal(m.missing.length, 0, `${doc}: every ground truth line must be findable`);
    assert.ok(m.inversions > 0, `${doc}: expected the layout table to interleave, got 0 inversions`);
  }
});
