import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remediateHTML, textPreserved, REPAIR_TARGET } from '../src/remediate.js';
import { auditDocument } from '../src/audit.js';
import { readGroundTruth } from '../src/readingorder.js';
import { parseHTML, byTag, textContent, findAll } from '../src/html/parse.js';
import { contrastRatio, parseColor, requiredRatio } from '../src/color.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const corpus = (name) => fs.readFileSync(path.join(HERE, '..', 'corpus', name), 'utf8');

const DOCS = [
  ['benefit-notice.html', 'benefit-notice.order.txt'],
  ['school-letter.html', 'school-letter.order.txt']
];

// This is the assertion the whole project turns on. It is deliberately written against the
// remediated HTML text rather than against the tool's own report object, because a report is
// a claim and the document is the deliverable.
function measureFile(html, expectedOrder) {
  return auditDocument(html, { expectedOrder });
}

for (const [doc, orderFile] of DOCS) {
  const expectedOrder = readGroundTruth(corpus(orderFile));

  test(`${doc}: the original fails the checks, so the remediation has something to prove`, () => {
    const before = measureFile(corpus(doc), expectedOrder);
    assert.ok(before.summary.failingContrast > 0, 'expected contrast failures in the source');
    assert.ok(before.summary.justifiedRuns > 0, 'expected justified text in the source');
    assert.ok(before.summary.readingOrder.inversions > 0, 'expected a reading order defect');
    assert.ok(before.summary.layoutTables > 0, 'expected a layout table');
    assert.equal(before.summary.lang, null, 'expected no html lang');
  });

  test(`${doc}: the remediated output passes every check the original failed`, () => {
    const result = remediateHTML(corpus(doc), { expectedOrder });
    // Re-measured from the output string, not read off result.after, so a report that lies
    // about its own document cannot make this pass.
    const after = measureFile(result.html, expectedOrder);

    assert.equal(after.summary.failingContrast, 0,
      `still failing: ${JSON.stringify(after.textRuns.filter((r) => !r.pass).map((r) => [r.sample, r.ratio, r.required]))}`);
    assert.ok(after.summary.minContrast >= REPAIR_TARGET,
      `minimum contrast ${after.summary.minContrast} is under the ${REPAIR_TARGET} target`);
    assert.equal(after.summary.justifiedRuns, 0);
    assert.equal(after.summary.tightLineHeightRuns, 0);
    assert.equal(after.summary.belowMinimumFontRuns, 0);
    assert.equal(after.summary.tightTrackingRuns, 0);
    assert.equal(after.summary.readingOrder.inversions, 0,
      'the reading order defect must be gone, not merely reduced');
    assert.equal(after.summary.readingOrder.missing, 0,
      'every ground truth line must still be findable in the output');
    assert.equal(after.summary.layoutTables, 0);
    assert.equal(after.summary.visualHeadings, 0);
    assert.equal(after.summary.lang, 'en');
    assert.equal(after.summary.hasTitle, true);
    assert.ok(after.summary.headings > 0, 'the faked headings should now be real ones');
    assert.deepEqual(after.summary.headingSkips, []);
  });

  test(`${doc}: every ratio in the output is recomputed from its own colour pair`, () => {
    const result = remediateHTML(corpus(doc), { expectedOrder });
    const after = measureFile(result.html, expectedOrder);
    assert.ok(after.textRuns.length > 0);
    for (const run of after.textRuns) {
      const recomputed = contrastRatio(parseColor(run.foreground), parseColor(run.background));
      assert.ok(Math.abs(recomputed - run.ratio) < 1e-3,
        `${run.sample}: reported ${run.ratio}, recomputed ${recomputed}`);
      assert.equal(run.required, requiredRatio(run.fontSizePx, run.fontWeight));
      assert.equal(run.pass, recomputed >= run.required);
    }
  });

  test(`${doc}: not one word of the original is lost`, () => {
    const result = remediateHTML(corpus(doc), { expectedOrder });
    const p = textPreserved(corpus(doc), result.html);
    assert.equal(p.preserved, true, `missing words: ${p.missing.slice(0, 20).join(' ')}`);
    assert.ok(p.sourceWords > 100, 'the source should be a substantial document');
  });

  test(`${doc}: no alt text is invented`, () => {
    const result = remediateHTML(corpus(doc), { expectedOrder });
    const outRoot = parseHTML(result.html);
    const srcRoot = parseHTML(corpus(doc));
    const srcAlts = new Map(byTag(srcRoot, 'img').map((i) => [i.attrs.src, i.attrs.alt]));
    for (const img of byTag(outRoot, 'img')) {
      const original = srcAlts.get(img.attrs.src);
      if (img.attrs['data-lgb-alt-status'] === 'auto-decorative') {
        assert.equal(img.attrs.alt, '', 'a proven spacer gets an empty alt and role=presentation');
        assert.equal(img.attrs.role, 'presentation');
        continue;
      }
      assert.equal(img.attrs.alt, original,
        `alt text for ${img.attrs.src} was changed from ${JSON.stringify(original)} to ${JSON.stringify(img.attrs.alt)}`);
    }
    // And an image the tool could not describe is announced in the page, not left silent.
    const flags = findAll(outRoot, (n) => n.type === 'element' && (n.attrs.class || '').includes('lgb-alt-flag'));
    const needsHuman = result.report.images.counts.needsHuman;
    assert.equal(flags.length, needsHuman, 'one visible flag per image that needs a description');
    assert.ok(needsHuman > 0, 'this corpus document should have an image with unusable alt text');
  });
}

test('the remediated output is stable: running it twice gives the same document', () => {
  const a = remediateHTML(corpus('benefit-notice.html'), {}).html;
  const b = remediateHTML(corpus('benefit-notice.html'), {}).html;
  assert.equal(a, b);
});

test('an already accessible document is not made worse', () => {
  const src = corpus('accessible-control.html');
  const before = auditDocument(src);
  assert.equal(before.summary.failingContrast, 0, 'the control document should start clean');
  const result = remediateHTML(src, {});
  const after = auditDocument(result.html);
  assert.equal(after.summary.failingContrast, 0);
  assert.ok(after.summary.minContrast >= REPAIR_TARGET);
  assert.equal(textPreserved(src, result.html).preserved, true);
  // The data table has real headers and a caption, so it carries meaning and must survive.
  assert.equal(byTag(parseHTML(result.html), 'table').length, 1, 'a data table must not be unwrapped');
  assert.equal(byTag(parseHTML(result.html), 'th').length, 3);
  // Its described image keeps the description the author wrote.
  const images = byTag(parseHTML(result.html), 'img');
  const described = images.find((i) => (i.attrs.src || '').includes('library-front'));
  assert.ok(described, 'the photograph should still be in the output');
  assert.match(described.attrs.alt, /ramp on the left/);
  // And its decorative divider keeps its empty alt. An empty alt is correct markup here, and a
  // remediation that "helpfully" filled it in would be inventing a description for a rule.
  const decorative = images.find((i) => (i.attrs.src || '').includes('section-rule'));
  assert.ok(decorative, 'the decorative rule should still be in the output');
  assert.equal(decorative.attrs.alt, '');
  assert.equal(decorative.attrs['data-lgb-alt-status'], 'declared-decorative');
});

test('the plain language summary is added beside the original, never over it', () => {
  const src = corpus('benefit-notice.html');
  const summary = { title: 'Plain language summary', paragraphs: ['Your benefit amount is going down next month.', 'You can ask for a hearing.'] };
  const result = remediateHTML(src, { summary });
  assert.equal(result.report.summaryInserted, true);
  const root = parseHTML(result.html);
  const aside = findAll(root, (n) => n.type === 'element' && (n.attrs.class || '').includes('lgb-summary'))[0];
  assert.ok(aside, 'the summary block should be in the output');
  assert.match(textContent(aside), /Your benefit amount is going down next month/);
  assert.match(textContent(aside), /Written by a language model/, 'the machine origin must be visible to the reader');
  // The original wording is still all there, which is the point of "alongside".
  assert.equal(textPreserved(src, result.html).preserved, true);
  const main = byTag(root, 'main')[0];
  assert.ok(main, 'the original document keeps its own landmark');
  assert.match(textContent(main), /Your household benefit amount changes/);
  assert.doesNotMatch(textContent(main), /Written by a language model/, 'the summary is outside <main>, not inside it');
});

test('textPreserved actually notices a deletion', () => {
  // A preservation check that cannot fail is worse than none, so this proves it fails.
  const src = '<body><p>Keep every single word of this notice.</p></body>';
  const trimmed = '<body><p>Keep every word of this notice.</p></body>';
  assert.equal(textPreserved(src, src).preserved, true);
  const p = textPreserved(src, trimmed);
  assert.equal(p.preserved, false);
  assert.deepEqual(p.missing, ['single']);
});

test('textPreserved is not fooled by words moving between blocks', () => {
  // Unwrapping a layout table concatenates cell text. The check inserts a space at every
  // element boundary in both documents so "endof" and "Start" do not merge into one word that
  // then looks like two missing words.
  const src = '<table><tr><td>alpha</td><td>beta</td></tr></table>';
  const out = '<div><div>alpha</div><div>beta</div></div>';
  assert.equal(textPreserved(src, out).preserved, true);
});

test('the report counts match the document it describes', () => {
  const result = remediateHTML(corpus('school-letter.html'), {});
  const root = parseHTML(result.html);
  const shaded = findAll(root, (n) => n.type === 'element' && (n.attrs.class || '').split(/\s+/).includes('lgb-shade'));
  assert.equal(shaded.length, result.report.shading.shaded, 'shaded paragraph count must match the document');
  const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].flatMap((t) => byTag(root, t));
  assert.ok(headings.length >= result.report.headingsPromoted.length);
});

test('a document with no faults is reported as needing no colour changes', () => {
  const result = remediateHTML(corpus('accessible-control.html'), {});
  const moved = result.report.colorRepairs.filter((r) => r.changed);
  assert.equal(moved.length, 0, `changed ${moved.length} colours in a document that already passed`);
});
