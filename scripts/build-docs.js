#!/usr/bin/env node
// Generate docs/index.html from the fingerprint, so the published page cannot drift from the
// measurements. verify.sh rebuilds it and diffs against the committed copy.
//
// The page carries an inline script that recomputes every ratio it displays, in the reader's
// browser, from the hex pair printed next to it. That is not decoration. It means a wrong
// number on the page announces itself to anyone who opens it, and it gives the browser check
// something the script must have produced to assert on.
//
//   node scripts/build-docs.js            write docs/index.html
//   node scripts/build-docs.js --check    exit 1 if the committed page is not what this builds

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'docs', 'index.html');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (x) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(2));

function fingerprint() {
  const raw = execFileSync(process.execPath, [path.join(HERE, 'fingerprint.js')], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  return JSON.parse(raw);
}

function documentRows(documents) {
  const rows = [];
  for (const [name, entry] of Object.entries(documents)) {
    if (!entry.before) continue;
    rows.push(`      <tr>
        <th scope="row">${esc(name)}</th>
        <td>${entry.before.textRuns}</td>
        <td class="${entry.before.failingContrast ? 'bad' : 'good'}">${entry.before.failingContrast}</td>
        <td class="${entry.after.failingContrast ? 'bad' : 'good'}">${entry.after.failingContrast}</td>
        <td>${n2(entry.before.minContrast)}:1</td>
        <td class="${entry.after.minContrast >= 4.5 ? 'good' : 'bad'}">${n2(entry.after.minContrast)}:1</td>
        <td>${entry.before.readingOrder ? entry.before.readingOrder.inversions : 'n/a'}</td>
        <td class="${entry.after.readingOrder && entry.after.readingOrder.inversions === 0 ? 'good' : ''}">${entry.after.readingOrder ? entry.after.readingOrder.inversions : 'n/a'}</td>
        <td>${entry.before.images.needsHuman}</td>
      </tr>`);
  }
  return rows.join('\n');
}

function pdfRows(documents) {
  const rows = [];
  for (const [name, entry] of Object.entries(documents)) {
    if (!entry.perPage) continue;
    for (const page of entry.perPage) {
      rows.push(`      <tr>
        <th scope="row">${esc(name)} p${page.number}</th>
        <td>${page.textRuns}</td>
        <td>${page.columns}</td>
        <td>${page.streamOrderInversions} of ${page.streamOrderPairs}</td>
        <td class="${entry.readingOrderReflow && entry.readingOrderReflow.inversions === 0 ? 'good' : 'bad'}">${entry.readingOrderReflow ? entry.readingOrderReflow.inversions : 'n/a'}</td>
        <td class="${entry.tagged ? 'good' : 'bad'}">${entry.tagged ? 'present' : 'missing'}</td>
        <td class="${entry.lang ? 'good' : 'bad'}">${entry.lang || 'missing'}</td>
      </tr>`);
    }
  }
  return rows.join('\n');
}

function contrastRows(contrast) {
  return contrast.map(([fg, bg, ratio]) => `      <tr data-fg="${esc(fg)}" data-bg="${esc(bg)}" data-ratio="${ratio}">
        <td><span class="swatch" style="background:${esc(bg)};color:${esc(fg)}">Aa</span> <code>${esc(fg)}</code> on <code>${esc(bg)}</code></td>
        <td class="num">${Number(ratio).toFixed(4)}:1</td>
        <td class="recheck">not yet rechecked</td>
      </tr>`).join('\n');
}

function largeRows(large) {
  return large.map(([px, weight, isLarge, required]) => `      <tr>
        <td class="num">${px}px</td>
        <td class="num">${weight}</td>
        <td>${(px / (96 / 72)).toFixed(2)}pt</td>
        <td>${isLarge ? 'large' : 'normal'}</td>
        <td class="num">${required.toFixed(1)}:1</td>
      </tr>`).join('\n');
}

function altRows(images) {
  const label = {
    'described': 'kept, it says something',
    'declared-decorative': 'author marked it decorative',
    'auto-decorative': 'proved decorative from evidence',
    'needs-human': 'flagged, no description invented'
  };
  return images.map(([src, alt, width, role, status]) => `      <tr>
        <td><code>${esc(src)}</code></td>
        <td>${alt === null ? '<em>no alt attribute</em>' : `<code>${esc(JSON.stringify(alt))}</code>`}</td>
        <td>${role ? `<code>role=${esc(role)}</code>` : (width ? `${esc(width)}px wide` : '')}</td>
        <td class="${status === 'needs-human' ? 'bad' : 'good'}">${esc(status)}</td>
        <td>${esc(label[status] || '')}</td>
      </tr>`).join('\n');
}

function build() {
  const fp = fingerprint();
  const docCount = Object.values(fp.documents).filter((d) => d.before).length;
  const pdfCount = Object.values(fp.documents).filter((d) => d.perPage).length;
  const probeCount = fp.probes.contrast.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>legible-docs, measured</title>
<style>
  :root { color-scheme: light dark; --ink: #1a1a1a; --page: #ffffff; --band: #eef1f5;
          --rule: #595959; --good: #17532b; --bad: #8a1c1c; --muted: #3d3d3d; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #f2f2f2; --page: #14171c; --band: #1e232b; --rule: #8e97a3;
            --good: #7fd6a0; --bad: #ff9f9f; --muted: #c2c8d0; }
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Atkinson Hyperlegible', Verdana, 'DejaVu Sans', sans-serif;
    font-size: 18px; line-height: 1.6; letter-spacing: 0.01em;
    color: var(--ink); background: var(--page);
    margin: 0; padding: 2rem 1.25rem 5rem; text-align: left; hyphens: none;
  }
  main { max-width: 68ch; margin: 0 auto; }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 0.4em; }
  h2 { font-size: 1.35rem; line-height: 1.3; margin: 2.2em 0 0.5em; border-bottom: 2px solid var(--rule); padding-bottom: 0.2em; }
  h3 { font-size: 1.1rem; margin: 1.6em 0 0.4em; }
  p, li { max-width: 68ch; }
  .lede { font-size: 1.05rem; color: var(--muted); }
  code { font-family: ui-monospace, 'DejaVu Sans Mono', monospace; font-size: 0.9em;
         background: var(--band); padding: 0.1em 0.35em; border-radius: 3px; }
  pre { background: var(--band); padding: 0.9em 1em; overflow-x: auto; border-left: 4px solid var(--rule); }
  pre code { background: none; padding: 0; }
  .scroll { overflow-x: auto; margin: 1em 0; border: 1px solid var(--rule); }
  table { border-collapse: collapse; width: 100%; min-width: 34rem; }
  caption { text-align: left; padding: 0.5em 0.7em; font-weight: 700; background: var(--band); }
  th, td { border: 1px solid var(--rule); padding: 0.4em 0.65em; text-align: left; vertical-align: top; }
  thead th { background: var(--band); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .good { color: var(--good); font-weight: 700; }
  .bad { color: var(--bad); font-weight: 700; }
  .swatch { display: inline-block; min-width: 2.4em; text-align: center; padding: 0.15em 0.4em;
            border: 1px solid var(--rule); font-weight: 700; }
  #verdict { border: 3px solid var(--rule); padding: 0.9em 1.1em; margin: 1.2em 0; background: var(--band); }
  #verdict.pass { border-color: var(--good); }
  #verdict.fail { border-color: var(--bad); }
  .cannot { border-left: 6px solid var(--bad); padding: 0.2em 0 0.2em 1em; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 2px solid var(--rule); color: var(--muted); font-size: 0.92rem; }
  a { color: inherit; }
</style>
</head>
<body>
<main>

<h1>legible-docs, measured</h1>

<p class="lede">A command line tool and a browser extension that reflow public notices, school
letters, and benefit forms for dyslexic and low vision readers, and report in numbers what they
changed and what they could not.</p>

<p>Every figure on this page was produced by running the tool over the corpus in the repository.
The page is generated from that run by <code>scripts/build-docs.js</code>, and
<code>scripts/verify.sh</code> rebuilds it and fails if it differs from the committed copy, so
it cannot quietly go stale.</p>

<div id="verdict" role="status">
  <strong>Recheck:</strong> <span id="verdict-text">this page recomputes its own contrast
  figures in your browser. If scripting is off, the numbers below are the ones published and
  nothing has rechecked them.</span>
</div>

<h2>What it does to a document</h2>

<p>The tool never removes or rewords the document's text. A benefit notice is a legal document
and the wording is the thing being delivered. What changes is presentation: the typeface, the
tracking, the line height, ragged right instead of justified, alternating paragraph shading,
real headings instead of bold paragraphs, and colours moved until they meet contrast. An
optional plain language summary from a local model is placed <em>alongside</em> the original,
never over it, with a visible note saying a machine wrote it.</p>

<div class="scroll">
<table>
  <caption>${docCount} HTML documents, before and after remediation</caption>
  <thead>
    <tr>
      <th scope="col">Document</th>
      <th scope="col">Text runs</th>
      <th scope="col">Failing before</th>
      <th scope="col">Failing after</th>
      <th scope="col">Lowest before</th>
      <th scope="col">Lowest after</th>
      <th scope="col">Order inversions before</th>
      <th scope="col">after</th>
      <th scope="col">Images needing a person</th>
    </tr>
  </thead>
  <tbody>
${documentRows(fp.documents)}
  </tbody>
</table>
</div>

<p><code>accessible-control.html</code> is in the corpus on purpose. It already passes, and it
is there so a check that flags everything cannot look like a check that works.</p>

<h2>Reading order</h2>

<p>The defect that looks fine on screen: two stories side by side in a layout table read, to a
screen reader, as row one of the left story, row one of the right, row two of the left, and so
on. The page looks right and linearises wrong. Each corpus document ships a hand written
<code>.order.txt</code> listing its blocks in the order a person reads them aloud, and the
measurement is the Kendall tau distance between that and the order the markup produces.</p>

<div class="scroll">
<table>
  <caption>${pdfCount} PDF, extracted and reflowed</caption>
  <thead>
    <tr>
      <th scope="col">Page</th>
      <th scope="col">Text runs</th>
      <th scope="col">Columns</th>
      <th scope="col">Content stream order, inverted pairs</th>
      <th scope="col">After column aware reflow</th>
      <th scope="col">Tagged structure</th>
      <th scope="col">/Lang</th>
    </tr>
  </thead>
  <tbody>
${pdfRows(fp.documents)}
  </tbody>
</table>
</div>

<h2>Contrast</h2>

<p>The ratio is WCAG 2.1's: linearise each sRGB channel, weight them 0.2126, 0.7152 and 0.0722,
then take <code>(lighter + 0.05) / (darker + 0.05)</code>. The linearisation matters. Drop it
and <code>#767676</code> on white reads 2.05:1 instead of 4.54:1, which is the difference
between failing a colour that passes and passing one that fails.</p>

<div class="scroll">
<table>
  <caption>${probeCount} reference pairs, recomputed in your browser</caption>
  <thead>
    <tr><th scope="col">Pair</th><th scope="col" class="num">Published ratio</th><th scope="col">Recomputed here</th></tr>
  </thead>
  <tbody>
${contrastRows(fp.probes.contrast)}
  </tbody>
</table>
</div>

<h3>The large text exception</h3>

<p>WCAG asks for 4.5:1 normally and 3:1 for large text, where large means 18pt, or 14pt when
bold. One threshold for everything is wrong in both directions. The thresholds are converted
from points exactly, so 18pt is 24px and 14pt is 18.667px. Rounding the bold threshold down to
18.66px, which several checkers do, lets bold text at 13.995pt claim an allowance it has not
earned.</p>

<div class="scroll">
<table>
  <caption>How the requirement is chosen</caption>
  <thead>
    <tr><th scope="col" class="num">Size</th><th scope="col" class="num">Weight</th><th scope="col">In points</th><th scope="col">Classified</th><th scope="col" class="num">Requires</th></tr>
  </thead>
  <tbody>
${largeRows(fp.probes.large)}
  </tbody>
</table>
</div>

<h2>Alt text</h2>

<p>An empty <code>alt</code> is the correct markup for a decorative image and a silent
information loss on an informative one. A checker that flags every empty alt buries its real
findings under one false positive per divider rule on the page, and a checker that accepts any
alt at all passes <code>alt="image"</code>. So the tool sorts images into four outcomes, and it
never writes a description for an image it cannot see.</p>

<div class="scroll">
<table>
  <caption>How images are classified</caption>
  <thead>
    <tr><th scope="col">Source</th><th scope="col">alt</th><th scope="col">Other evidence</th><th scope="col">Outcome</th><th scope="col">Meaning</th></tr>
  </thead>
  <tbody>
${altRows(fp.probes.images)}
  </tbody>
</table>
</div>

<h2>What this tool cannot check</h2>

<div class="cannot">
<ul>
  <li><strong>It cannot see an image.</strong> No alt text is ever generated. An image with no
  usable description is flagged in the output for a person to write, and the missing alt is
  left missing so every other checker still reports it.</li>
  <li><strong>It cannot read a scanned PDF.</strong> A page with no text layer is reported as
  needing optical character recognition. No text is invented for it.</li>
  <li><strong>It does not fetch external stylesheets.</strong> A colour that lives in a linked
  CSS file is reported as unmeasured, with a warning naming the file.</li>
  <li><strong>It does not evaluate at-rules.</strong> Colours inside <code>@media</code> or
  <code>@supports</code> are skipped and warned about rather than guessed at.</li>
  <li><strong>The command line tool has no browser.</strong> It implements a small CSS cascade
  covering type, class, id, descendant and child selectors, inline styles and the old
  presentational attributes. It does not do JavaScript, custom properties beyond simple
  substitution, flexbox, grid, or any layout. The browser extension has a real engine and uses
  <code>getComputedStyle</code>, so on the same document the two can disagree slightly and the
  extension is the more accurate of the two.</li>
  <li><strong>It cannot tell you whether the writing is any good.</strong> Contrast, spacing and
  order are measurable. Whether a benefit notice makes sense to the person who received it is
  not, and nothing here should be read as saying it does.</li>
  <li><strong>The plain language summary is machine written and can be wrong.</strong> It is off
  by default, it runs against a local model and never a hosted API, it is placed beside the
  original text, and it carries a visible note saying so.</li>
</ul>
</div>

<h2>Running it</h2>

<pre><code>legible audit corpus/benefit-notice.html
legible fix   corpus/benefit-notice.html --out readable.html --face atkinson
legible fix   corpus/public-notice.pdf   --out readable.html --summary
legible pdf-text corpus/public-notice.pdf</code></pre>

<p>The browser extension is unpacked: load <code>extension/</code> in Chrome from
<em>Manage extensions</em>, <em>Load unpacked</em>. It asks for <code>activeTab</code> and
<code>scripting</code>, and nothing else. It makes no network request of any kind, which is
asserted in the test suite rather than promised here, because a benefit notice is not something
anybody should be uploading to a server to have it made readable.</p>

<footer>
<p>Catalog task CIVIC-044, from a public catalog of build ideas at
<a href="https://github.com/JesseRWeigel/722-things-to-build">722-things-to-build</a>.
MIT licensed. Generated from <code>scripts/fingerprint.js</code>; do not edit this file by hand,
edit <code>scripts/build-docs.js</code> instead.</p>
</footer>

</main>

<script>
// Recompute every published contrast ratio, here, in the reader's browser, from the hex pair
// in each row. A page that prints numbers it cannot reproduce should say so out loud.
(function () {
  function toLinear(c8) {
    var c = c8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function luminance(hex) {
    var h = hex.replace('#', '');
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }
  function ratio(fg, bg) {
    var a = luminance(fg), b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  var rows = document.querySelectorAll('tr[data-fg]');
  var checked = 0, mismatched = 0;
  rows.forEach(function (row) {
    var mine = ratio(row.dataset.fg, row.dataset.bg);
    var published = parseFloat(row.dataset.ratio);
    var cell = row.querySelector('.recheck');
    var ok = Math.abs(mine - published) < 5e-4;
    checked += 1;
    if (!ok) mismatched += 1;
    cell.textContent = ok ? mine.toFixed(4) + ':1, matches' : mine.toFixed(4) + ':1, DOES NOT MATCH';
    cell.className = 'recheck ' + (ok ? 'good' : 'bad');
  });

  var box = document.getElementById('verdict');
  var text = document.getElementById('verdict-text');
  var result = { checked: checked, mismatched: mismatched };
  if (checked === 0) {
    box.className = 'fail';
    text.textContent = 'No contrast rows were found on this page, so nothing was rechecked.';
  } else if (mismatched === 0) {
    box.className = 'pass';
    text.textContent = 'All ' + checked + ' published contrast ratios were recomputed in this '
      + 'browser and all ' + checked + ' match.';
  } else {
    box.className = 'fail';
    text.textContent = mismatched + ' of ' + checked + ' published contrast ratios did NOT '
      + 'match when recomputed in this browser. Do not trust the numbers above.';
  }
  box.setAttribute('data-recheck', JSON.stringify(result));
}());
</script>

</body>
</html>
`;
}

const html = build();
if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) {
    console.error('docs/index.html does not exist. Run: node scripts/build-docs.js');
    process.exitCode = 1;
  } else if (fs.readFileSync(OUT, 'utf8') !== html) {
    console.error('docs/index.html is not what scripts/build-docs.js produces from the current '
      + 'measurements. The published page has gone stale. Run: node scripts/build-docs.js');
    process.exitCode = 1;
  } else {
    console.log(`docs/index.html matches the current measurements (${html.length} bytes)`);
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`wrote docs/index.html (${html.length} bytes)`);
}
