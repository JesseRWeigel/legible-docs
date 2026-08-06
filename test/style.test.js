import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, byTag, findFirst } from '../src/html/parse.js';
import { parseStylesheet, parseDeclarations, selectorMatches, declaredStyles } from '../src/css.js';
import { computeStyles, lengthToPx } from '../src/style.js';
import { toHex, contrastRatio } from '../src/color.js';
import { collectStylesheet, auditDocument } from '../src/audit.js';

function styleOfFirst(html, tag, options) {
  const root = parseHTML(html);
  const sheet = collectStylesheet(root);
  const { styles, warnings } = computeStyles(root, sheet, options);
  const el = byTag(root, tag)[0];
  return { st: styles.get(el), warnings, sheet, root };
}

test('declarations parse, including !important', () => {
  const d = parseDeclarations('color: red; background: #fff !important; broken; :novalue; font-size:');
  assert.equal(d.color, 'red');
  assert.equal(d.background, '#fff');
  assert.equal(d['background!important'], true);
  assert.equal(d.broken, undefined);
});

test('at-rules are recorded as a warning rather than silently dropped', () => {
  const sheet = parseStylesheet('@media print { p { color: #000 } } p { color: #999 }');
  assert.equal(sheet.rules.length, 1, 'only the top level rule is applied');
  assert.equal(sheet.rules[0].declarations.color, '#999');
  assert.ok(sheet.warnings.some((w) => /@media/.test(w)),
    'a colour hidden inside an at-rule must produce a warning, not a quietly wrong measurement');
});

test('an external stylesheet is reported as unmeasured', () => {
  const root = parseHTML('<head><link rel="stylesheet" href="theme.css"></head><p>x</p>');
  const sheet = collectStylesheet(root);
  assert.ok(sheet.warnings.some((w) => /theme\.css/.test(w)));
});

test('comma separated selector groups become separate rules', () => {
  const sheet = parseStylesheet('h1, h2 , .lead { color: #123456 }');
  assert.equal(sheet.rules.length, 3);
  assert.deepEqual(sheet.rules.map((r) => r.selector), ['h1', 'h2', '.lead']);
});

test('selectors match by type, class, id, descendant and child', () => {
  const root = parseHTML('<div class="box"><section id="s"><p class="lead x">t</p></section></div>');
  const p = byTag(root, 'p')[0];
  for (const sel of ['p', '.lead', '.lead.x', 'p.lead', '*', 'div p', '.box p', '#s p', '#s > p', 'div .lead']) {
    assert.equal(selectorMatches(p, sel), true, `${sel} should match`);
  }
  for (const sel of ['a', '.missing', '#nope', 'p > div', 'section > div > p', '.lead.absent']) {
    assert.equal(selectorMatches(p, sel), false, `${sel} should not match`);
  }
});

test('a child combinator does not match a grandparent', () => {
  const root = parseHTML('<div><section><p>t</p></section></div>');
  const p = byTag(root, 'p')[0];
  assert.equal(selectorMatches(p, 'section > p'), true);
  assert.equal(selectorMatches(p, 'div > p'), false);
});

test('specificity and source order decide the winner', () => {
  const root = parseHTML('<p id="a" class="b">t</p>');
  const p = byTag(root, 'p')[0];
  const sheet = parseStylesheet('p { color: #111111 } .b { color: #222222 } #a { color: #333333 }');
  assert.equal(declaredStyles(p, sheet).color, '#333333', 'the id selector wins');
  const later = parseStylesheet('p { color: #111111 } p { color: #444444 }');
  assert.equal(declaredStyles(p, later).color, '#444444', 'equal specificity, later rule wins');
});

test('an inline style beats a stylesheet, and !important beats an inline style', () => {
  const root = parseHTML('<p style="color: #aaaaaa">t</p>');
  const p = byTag(root, 'p')[0];
  assert.equal(declaredStyles(p, parseStylesheet('p { color: #bbbbbb }')).color, '#aaaaaa');
  assert.equal(declaredStyles(p, parseStylesheet('p { color: #cccccc !important }')).color, '#cccccc');
});

test('lengths convert, and points convert at 96 over 72', () => {
  assert.equal(lengthToPx('12px', 16), 12);
  assert.equal(lengthToPx('9pt', 16), 12);
  assert.equal(lengthToPx('18pt', 16), 24);
  assert.equal(lengthToPx('1.5em', 20), 30);
  assert.equal(lengthToPx('2rem', 20, 16), 32);
  assert.equal(lengthToPx('50%', 20), 10);
  assert.equal(lengthToPx('large', 16), 18);
  assert.equal(lengthToPx('not-a-length', 16), null);
});

test('a colour the parser cannot read produces a warning, not a wrong number', () => {
  const { warnings } = styleOfFirst('<style>p{color: var(--brand)}</style><p>t</p>', 'p');
  assert.ok(warnings.some((w) => /unparsed color/.test(w)),
    'an unreadable colour must be announced, otherwise the run is measured as inherited black');
});

test('colour and size inherit down the tree', () => {
  const html = '<style>body{color:#993333; font-size: 20px}</style><body><div><p><span>t</span></p></div></body>';
  const root = parseHTML(html);
  const { styles } = computeStyles(root, collectStylesheet(root), {});
  const span = byTag(root, 'span')[0];
  assert.equal(toHex(styles.get(span).color), '#993333');
  assert.equal(styles.get(span).fontSizePx, 20);
});

test('the background a run is painted on comes from the nearest ancestor that sets one', () => {
  const html = '<style>body{background:#ffffff} .panel{background-color:#222222} p{color:#ffffff}</style>'
    + '<body><div class="panel"><p>t</p></div></body>';
  const { st } = styleOfFirst(html, 'p');
  assert.equal(toHex(st.background), '#222222');
  assert.equal(Number(contrastRatio(st.color, st.background).toFixed(2)), 15.91);
});

test('a translucent panel is composited onto what is behind it', () => {
  const html = '<style>body{background:#000000} .panel{background-color:rgba(255,255,255,0.5)} p{color:#ffffff}</style>'
    + '<body><div class="panel"><p>t</p></div></body>';
  const { st } = styleOfFirst(html, 'p');
  assert.equal(toHex(st.background), '#808080', 'white at 50% over black is mid grey');
  // The composited value is kept unrounded (127.5), so the ratio is 3.9767 rather than the
  // 3.9494 an 8-bit #808080 would give. Measuring against the declared #ffffff would report
  // 1:1 and against the page black 21:1, and both of those are wrong.
  assert.ok(Math.abs(contrastRatio(st.color, st.background) - 3.9766530) < 1e-6,
    `got ${contrastRatio(st.color, st.background)}`);
});

test('legacy presentational markup is read the way a browser reads it', () => {
  const html = '<body bgcolor="#000080"><font size="5" color="#ffff00">Notice</font></body>';
  const { st } = styleOfFirst(html, 'font');
  assert.equal(toHex(st.color), '#ffff00');
  assert.equal(toHex(st.background), '#000080');
  assert.equal(st.fontSizePx, 24, 'font size=5 is 24px on the classic scale');
});

test('user agent defaults apply to headings and bold elements', () => {
  const { st: h1 } = styleOfFirst('<h1>T</h1>', 'h1');
  assert.equal(h1.fontSizePx, 32);
  assert.equal(h1.fontWeight, 700);
  const { st: th } = styleOfFirst('<table><tr><th>T</th></tr></table>', 'th');
  assert.equal(th.fontWeight, 700);
  assert.equal(th.textAlign, 'center');
});

test('hidden elements are excluded from the measurement', () => {
  const html = '<style>.gone{display:none} .invis{visibility:hidden}</style>'
    + '<p class="gone">hidden one</p><p class="invis">hidden two</p><p>visible</p>';
  const audit = auditDocument(html);
  assert.equal(audit.textRuns.length, 1);
  assert.equal(audit.textRuns[0].sample, 'visible');
});

test('a child of a hidden element stays hidden', () => {
  const html = '<style>.gone{display:none}</style><div class="gone"><p>still hidden</p></div><p>visible</p>';
  const audit = auditDocument(html);
  assert.deepEqual(audit.textRuns.map((r) => r.sample), ['visible']);
});

test('text is attributed to the element that paints it, not to every ancestor', () => {
  const html = '<style>span{color:#bbbbbb}</style><p>outer <span>inner</span></p>';
  const audit = auditDocument(html);
  const samples = audit.textRuns.map((r) => `${r.tag}:${r.sample}`);
  assert.deepEqual(samples, ['p:outer', 'span:inner'],
    'one sentence must not be counted twice at two different colours');
});

test('the audit reports a required ratio per run, not one threshold for the document', () => {
  const html = '<style>body{color:#949494;background:#ffffff}'
    + '.big{font-size:30px} .bigbold{font-size:20px;font-weight:bold}</style>'
    + '<body><p>small text here</p><p class="big">big text here</p><p class="bigbold">bold big text</p></body>';
  const audit = auditDocument(html);
  const by = Object.fromEntries(audit.textRuns.map((r) => [r.sample, r]));
  assert.equal(by['small text here'].required, 4.5);
  assert.equal(by['big text here'].required, 3);
  assert.equal(by['bold big text'].required, 3);
  // #949494 on white is 3.03:1, so the same colour passes at the large sizes and fails at 16px.
  assert.equal(by['small text here'].pass, false);
  assert.equal(by['big text here'].pass, true);
  assert.equal(by['bold big text'].pass, true);
});

test('a title element is never measured as page text', () => {
  const audit = auditDocument('<html><head><title>Not on the page</title></head><body><p>on the page</p></body></html>');
  assert.deepEqual(audit.textRuns.map((r) => r.sample), ['on the page']);
  assert.equal(audit.summary.hasTitle, true);
});

test('a heading level skip is reported', () => {
  const audit = auditDocument('<h1>A</h1><h3>B</h3>');
  assert.equal(audit.summary.headingSkips.length, 1);
  assert.match(audit.summary.headingSkips[0], /1 to 3/);
  assert.equal(auditDocument('<h1>A</h1><h2>B</h2><h3>C</h3>').summary.headingSkips.length, 0);
});

test('a line styled to look like a heading is counted as a faked heading', () => {
  const html = '<style>.h{font-weight:bold;font-size:22px}</style>'
    + `<p class="h">Section title</p><p>${'body text '.repeat(20)}</p>`;
  const audit = auditDocument(html);
  assert.equal(audit.summary.visualHeadings, 1);
  assert.equal(audit.summary.headings, 0);
});

test('table cells, captions and links are not mistaken for faked headings', () => {
  const html = '<table><caption>Hours</caption><tr><th>Day</th><td>Mon</td></tr></table>'
    + '<p><a href="#">A link</a></p><label>A label</label>';
  assert.equal(auditDocument(html).summary.visualHeadings, 0);
});
