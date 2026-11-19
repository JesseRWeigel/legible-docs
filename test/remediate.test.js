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

test('layout remediation retains structural fragment targets and reports the reading-order limit', () => {
  const input = `<html lang="en"><head><title>Schedule</title></head><body><main>
    <h1>Schedule</h1><p><a href="#deadline">Jump to deadline</a></p>
    <table id="schedule"><tbody><tr id="dates"><td id="deadline">
      <p>Deadline November 30 at 5 p.m.</p></td><td><p>Office hours</p></td></tr>
      <tr><td><p>Bring your form.</p></td><td><p>Call first.</p></td></tr></tbody></table>
    </main></body></html>`;
  const result = remediateHTML(input);
  const output = parseHTML(result.html);
  assert.equal(byTag(output, 'a').find((node) => node.attrs.href === '#deadline').attrs.href, '#deadline');
  for (const [tag, id] of [['table', 'schedule'], ['tr', 'dates'], ['td', 'deadline']]) {
    assert.equal(byTag(output, tag).filter((node) => node.attrs.id === id).length, 1);
  }
  assert.match(textContent(byTag(output, 'td')[0]), /Deadline November 30 at 5 p\.m\./);
  assert.equal(textPreserved(input, result.html).preserved, true);
  assert.equal(result.report.layoutTablesRetainedForAnchors, 1);
  assert.equal(result.report.layoutTablesUnwrapped, 0);
  assert.match(result.report.actions.join('\n'), /preserve structural IDs; review reading order manually/);

  // IDs on the moved contents already survive; do not disable ordinary layout repair.
  const ordinary = input.replace(' id="schedule"', '').replace(' id="dates"', '')
    .replace('<td id="deadline">', '<td>').replace('<p>Deadline', '<p id="deadline">Deadline');
  const repaired = remediateHTML(ordinary);
  assert.equal(repaired.report.layoutTablesUnwrapped, 1);
  assert.equal(repaired.report.layoutTablesRetainedForAnchors, 0);
  assert.equal(byTag(parseHTML(repaired.html), 'p').filter((node) => node.attrs.id === 'deadline').length, 1);
});

test('a retained nested table preserves its anchor and deadline exactly once', () => {
  const input = `<html lang="en"><head><title>Schedule</title></head><body><main>
    <h1>Schedule</h1><p><a href="#dates">Jump to dates</a></p>
    <table role="presentation"><tr><td>Outer left
      <table role="presentation"><tbody id="dates"><tr><td>Deadline November 30 at 5 p.m.</td>
      <td>Inner right</td></tr></tbody></table>
    </td><td>Outer right</td></tr><tr><td>Bottom left</td><td>Bottom right</td></tr></table>
  </main></body></html>`;
  const result = remediateHTML(input);
  const output = parseHTML(result.html);
  assert.equal(byTag(output, 'a').filter((node) => node.attrs.href === '#dates').length, 1);
  const target = byTag(output, 'tbody').filter((node) => node.attrs.id === 'dates');
  assert.equal(target.length, 1);
  assert.match(textContent(target[0]), /Deadline November 30 at 5 p\.m\./);
  assert.equal((result.html.match(/Deadline November 30 at 5 p\.m\./g) || []).length, 1);
  assert.equal(byTag(output, 'table').length, 2);
  assert.equal(result.report.layoutTablesRetainedForAnchors, 2);
  assert.equal(result.report.layoutTablesUnwrapped, 0);

  // A semantic table can be protected even though it is not an unwrap candidate.
  const semantic = input.replace('<table role="presentation"><tbody', '<table><tbody')
    .replace('<td>Inner right</td>', '<th>Inner right</th>');
  const semanticResult = remediateHTML(semantic);
  const semanticOutput = parseHTML(semanticResult.html);
  assert.equal(byTag(semanticOutput, 'tbody').filter((node) => node.attrs.id === 'dates').length, 1);
  assert.equal((semanticResult.html.match(/Deadline November 30 at 5 p\.m\./g) || []).length, 1);
  assert.equal(byTag(semanticOutput, 'table').length, 2);
  assert.equal(semanticResult.report.layoutTablesRetainedForAnchors, 1);
});

test('layout remediation does not copy surviving unanchored nested data cells twice', () => {
  const input = `<html lang="en"><head><title>Registration</title></head><body>
    <h1>Registration</h1>
    <table role="presentation"><tr><td><p>Registration schedule:</p>
      <table><caption>Session dates</caption><thead><tr><th scope="col">Session</th>
      <th scope="col">Date</th></tr></thead><tbody><tr><td>Application deadline</td>
      <td>November 30 at 5 PM</td></tr></tbody></table></td>
      <td><p>Contact the office.</p></td></tr></table>
    <table role="none"><tr><td><p>Other location</p></td><td><p>Other contact</p></td></tr></table>
  </body></html>`;
  const result = remediateHTML(input);
  const output = parseHTML(result.html);
  for (const wording of ['November 30 at 5 PM', 'Application deadline', 'Registration schedule:',
    'Contact the office.', 'Other location', 'Other contact']) {
    assert.equal(result.html.split(wording).length - 1, 1, wording);
  }
  const [outer, data] = byTag(output, 'table');
  assert.equal(byTag(output, 'table').length, 2);
  assert.equal(outer.attrs.role, 'presentation');
  assert.equal(byTag(outer, 'table')[1], data);
  assert.equal(textContent(byTag(data, 'caption')[0]), 'Session dates');
  assert.deepEqual(byTag(data, 'th').map((header) => header.attrs.scope), ['col', 'col']);
  assert.equal(result.report.layoutTablesRetainedForAnchors, 0);
  assert.equal(result.report.layoutTablesRetainedForNestedTables, 1);
  assert.equal(result.report.layoutTablesUnwrapped, 1);
  assert.match(result.report.actions.join('\n'), /preserve nested tables; review reading order manually/);
});

test('layout-only nested tables still unwrap from the inside out', () => {
  const input = `<html lang="en"><head><title>Example</title></head><body>
    <table role="presentation"><tr><td><table role="none"><tr><td>Nested left</td>
    <td>Nested right</td></tr></table></td><td>Outer right</td></tr></table>
  </body></html>`;
  const result = remediateHTML(input);
  assert.equal(byTag(parseHTML(result.html), 'table').length, 0);
  for (const wording of ['Nested left', 'Nested right', 'Outer right']) {
    assert.equal(result.html.split(wording).length - 1, 1, wording);
  }
  assert.equal(result.report.layoutTablesRetainedForNestedTables, 0);
  assert.equal(result.report.layoutTablesUnwrapped, 2);
});
