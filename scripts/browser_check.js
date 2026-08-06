#!/usr/bin/env node
// Load the published page and the browser extension in a real Chrome and measure inside them.
//
// Two things unit tests structurally cannot catch, both of which have shipped from this
// workspace before:
//   - an inline script whose whole body fails to parse, so the page renders as static HTML
//     with no computed numbers in it while every unit test stays green
//   - extension code that works against a parsed tree and breaks against a live DOM, because
//     getComputedStyle, getBoundingClientRect and the CSS cascade are not the tree
//
// So the assertion is on something the script MUST have produced, never on the file existing
// and never on a screenshot. Measurement happens inside the page in JavaScript and is written
// into an element this script then reads out of --dump-dom.
//
// If no Chrome can be found this exits nonzero. A skipped browser check and a passing browser
// check look identical in a log, and the whole point of this file is the part that cannot be
// checked any other way.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync as run } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const CANDIDATES = [
  process.env.LEGIBLE_CHROME,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'
].filter(Boolean);

// PATH is walked here rather than shelling out to `command -v`, because passing a name to a
// shell means quoting it correctly and there is no reason to involve a shell to look at
// directory entries.
function findChrome() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const candidate of CANDIDATES) {
    if (candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // not here, keep looking
      }
    }
  }
  return null;
}

// Everything the page needs is inlined into a temp copy, so the browser loads one file from
// one directory and there is no chance of a stale server on a shared port answering instead.
function dumpDom(chrome, file) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'legible-chrome-'));
  try {
    return run(chrome, [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,1024',
      '--virtual-time-budget=8000',
      `--user-data-dir=${profile}`,
      '--dump-dom',
      `file://${file}`
    ], { encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

// Pull a JSON payload the page wrote into a known element. The element id is only in the
// generated markup, so the regex cannot accidentally match the script source that produced it.
function readProbe(dom, id) {
  const m = dom.match(new RegExp(`<pre id="${id}"[^>]*>([\\s\\S]*?)</pre>`));
  if (!m) return null;
  const text = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  try {
    return JSON.parse(text);
  } catch (err) {
    return { parseError: err.message, raw: text.slice(0, 400) };
  }
}

const failures = [];
const notes = [];
function check(ok, message) {
  if (!ok) failures.push(message);
  return ok;
}

function checkPublishedPage(chrome, work) {
  const source = path.join(ROOT, 'docs', 'index.html');
  if (!fs.existsSync(source)) {
    failures.push('docs/index.html does not exist');
    return;
  }
  const target = path.join(work, 'page.html');
  fs.copyFileSync(source, target);
  const dom = dumpDom(chrome, target);

  // Page identity first. The browser is a shared resource on this machine and a concurrent
  // agent can navigate it out from under a check, so every measurement is preceded by proof
  // that the thing measured is the thing intended.
  if (!check(/<title>legible-docs, measured<\/title>/.test(dom),
    'the loaded page is not docs/index.html, its title is not "legible-docs, measured"')) return;

  // The inline script must have run. data-recheck only exists if it did.
  const m = dom.match(/id="verdict"[^>]*data-recheck="([^"]*)"/);
  if (!check(m, 'the page\'s inline script did not run: #verdict has no data-recheck attribute. '
    + 'The page rendered as static HTML, which is what an unbalanced parenthesis in the script looks like.')) return;
  let recheck;
  try {
    recheck = JSON.parse(m[1].replace(/&quot;/g, '"'));
  } catch (err) {
    failures.push(`the page's recheck payload is not JSON: ${err.message}`);
    return;
  }
  check(recheck.checked >= 10, `the page rechecked only ${recheck.checked} contrast ratios, expected at least 10`);
  check(recheck.mismatched === 0,
    `${recheck.mismatched} of ${recheck.checked} published contrast ratios did not match when `
    + 'recomputed in the browser, so the published page is wrong');
  check(/All \d+ published contrast ratios were recomputed/.test(dom),
    'the page did not render its passing verdict text');
  // Match the rendered cell, not the phrase. The phrase is also a string literal inside the
  // page's own inline script, which --dump-dom returns verbatim, so a bare text search for it
  // is true on a page where every row passed.
  check(!/class="recheck bad"/.test(dom), 'at least one contrast row rendered as a mismatch');
  notes.push(`published page: inline script ran, ${recheck.checked} ratios recomputed in Chrome, ${recheck.mismatched} mismatched`);

  // Nothing may be off screen sideways. Checked by walking elements rather than by trusting
  // the absence of a scrollbar, and ignoring anything inside a container that scrolls on
  // purpose, because content scrolling inside its own box is correct.
  const probe = path.join(work, 'overflow.html');
  fs.writeFileSync(probe, fs.readFileSync(source, 'utf8').replace('</body>', `
<pre id="lgb-overflow-probe">pending</pre>
<script>
(function () {
  var docWidth = document.documentElement.clientWidth;
  var offenders = [];
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.id === 'lgb-overflow-probe') continue;
    var inScroller = false;
    for (var p = el.parentElement; p; p = p.parentElement) {
      var ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') { inScroller = true; break; }
    }
    if (inScroller) continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > docWidth + 1 || r.left < -1) {
      offenders.push({ tag: el.tagName, cls: el.className, right: Math.round(r.right), left: Math.round(r.left) });
    }
  }
  document.getElementById('lgb-overflow-probe').textContent = JSON.stringify({
    title: document.title,
    docWidth: docWidth,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: offenders.slice(0, 8)
  });
}());
</script>
</body>`));
  const overflowDom = dumpDom(chrome, probe);
  const overflow = readProbe(overflowDom, 'lgb-overflow-probe');
  if (check(overflow && !overflow.parseError, `the overflow probe did not run: ${JSON.stringify(overflow)}`)) {
    check(overflow.title === 'legible-docs, measured', 'the overflow probe ran against a different page');
    check(overflow.offenders.length === 0,
      `${overflow.offenders.length} element(s) escape the page sideways: ${JSON.stringify(overflow.offenders)}`);
    check(overflow.scrollWidth <= overflow.docWidth + 1,
      `the document scrolls sideways: scrollWidth ${overflow.scrollWidth} against clientWidth ${overflow.docWidth}`);
    notes.push(`published page: no sideways overflow at 1280px, scrollWidth ${overflow.scrollWidth}`);
  }
}

function checkExtension(chrome, work) {
  // The real content script, against a real DOM, on the real corpus document. Nothing is
  // reimplemented here: the page loads extension/lib/legible-core.js and extension/content.js
  // exactly as the manifest declares them, then calls the functions the popup calls.
  const corpusFile = path.join(ROOT, 'corpus', 'benefit-notice.html');
  const source = fs.readFileSync(corpusFile, 'utf8');
  const core = fs.readFileSync(path.join(ROOT, 'extension', 'lib', 'legible-core.js'), 'utf8');
  const content = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

  const harness = `${source.replace(/<\/BODY>/i, '')}
<pre id="lgb-ext-probe">pending</pre>
<script>${core}</script>
<script>${content}</script>
<script>
(function () {
  var out = {};
  try {
    out.identity = document.body.textContent.indexOf('NOTICE OF ACTION ON YOUR BENEFITS') !== -1;
    var before = LegibleContent.audit(document);
    var applied = LegibleContent.apply(document, { face: 'atkinson' });
    var after = LegibleContent.audit(document);
    out.before = {
      textRuns: before.textRuns, failing: before.failingContrast, min: before.minContrast,
      justified: before.justifiedRuns, small: before.belowMinimumFontRuns,
      inversions: before.readingOrder.inversions, columns: before.readingOrder.columns,
      needsHuman: before.images.needsHuman
    };
    out.after = {
      textRuns: after.textRuns, failing: after.failingContrast, min: after.minContrast,
      justified: after.justifiedRuns, small: after.belowMinimumFontRuns,
      inversions: after.readingOrder.inversions,
      needsHuman: after.images.needsHuman
    };
    out.shaded = applied.shaded;
    out.flagged = applied.flagged;
    out.words = document.body.textContent.replace(/\\s+/g, ' ').trim().length;
    // The reader's own words must survive the reflow.
    out.keptOriginalText = document.body.textContent.indexOf('Your household benefit amount changes') !== -1;
    out.effectiveBackgroundOfBody = LegibleCore.toHex(LegibleContent.effectiveBackground(document.body));
    // And revert has to give the page back.
    LegibleContent.revert(document);
    var reverted = LegibleContent.audit(document);
    out.reverted = { failing: reverted.failingContrast, min: reverted.minContrast };
  } catch (err) {
    out.error = String(err && err.stack || err);
  }
  document.getElementById('lgb-ext-probe').textContent = JSON.stringify(out);
}());
</script>
</body></html>`;

  const target = path.join(work, 'extension-probe.html');
  fs.writeFileSync(target, harness);
  const dom = dumpDom(chrome, target);
  const r = readProbe(dom, 'lgb-ext-probe');

  if (!check(r && !r.parseError, `the extension probe produced nothing readable: ${JSON.stringify(r)}`)) return;
  if (!check(!r.error, `the extension threw in a real browser: ${r.error}`)) return;
  if (!check(r.identity, 'the extension probe ran against the wrong document')) return;

  // The source document has to be bad, otherwise the after numbers prove nothing.
  check(r.before.failing > 0, `the source measured 0 contrast failures in the browser, so there was nothing to fix`);
  check(r.before.min < 4.5, `the source's lowest contrast measured ${r.before.min}, which already passes`);
  check(r.before.justified > 0, 'the source measured no justified text in the browser');
  check(r.before.small > 0, 'the source measured no text under 16px in the browser');
  check(r.before.columns >= 2, `the browser found ${r.before.columns} visual column(s), expected the layout table to make 2`);
  check(r.before.inversions > 0,
    'the browser measured 0 reading order inversions on a document laid out with a side by side '
    + 'layout table, so the live DOM measurement is not seeing the defect');

  // And the reflow has to fix it, measured by the same code against the same live DOM.
  check(r.after.failing === 0, `${r.after.failing} run(s) still fail contrast in the browser after the reflow`);
  check(r.after.min >= 4.5, `lowest contrast after the reflow is ${r.after.min} in the browser`);
  check(r.after.justified === 0, `${r.after.justified} run(s) are still justified after the reflow`);
  check(r.after.small === 0, `${r.after.small} run(s) are still under 16px after the reflow`);
  check(r.after.textRuns > 0, 'the reflowed page has no measurable text left');
  check(r.keptOriginalText, 'the reflow lost the document\'s own wording');
  check(r.shaded > 0, 'no paragraphs were shaded');
  check(r.flagged > 0, 'no image was flagged, but this document has an image with a filename as its alt text');
  check(r.after.needsHuman > 0 && r.after.needsHuman === r.before.needsHuman,
    `the extension changed the count of images needing a human from ${r.before.needsHuman} to ${r.after.needsHuman}, which means it invented or destroyed a description`);
  check(r.effectiveBackgroundOfBody === '#ffffff',
    `the reflowed body background measured ${r.effectiveBackgroundOfBody}, expected #ffffff`);

  // Revert restores the original, which is what makes the extension safe to turn on.
  check(r.reverted.failing === r.before.failing,
    `after revert the page measures ${r.reverted.failing} failures, the original had ${r.before.failing}`);
  check(Math.abs(r.reverted.min - r.before.min) < 1e-6,
    `after revert the lowest contrast is ${r.reverted.min}, the original was ${r.before.min}`);

  notes.push(`extension in Chrome: ${r.before.failing} failing runs and ${r.before.inversions} order inversions before, `
    + `${r.after.failing} and ${r.after.inversions} after; ${r.shaded} paragraphs shaded, ${r.flagged} image flagged; revert restored the original`);
}

function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('BROWSER CHECK FAILED: no Chrome or Chromium found.');
    console.error(`  Tried: ${CANDIDATES.join(', ')}`);
    console.error('  Install one (Debian or Ubuntu: apt install chromium), or point LEGIBLE_CHROME');
    console.error('  at a binary. This is a failure and not a skip on purpose: it is the only check');
    console.error('  that runs the published page\'s inline script and the extension\'s content');
    console.error('  script against a real DOM. Everything else in verify.sh works on a parsed tree,');
    console.error('  so without this a page whose whole script fails to parse still passes.');
    return 1;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'legible-browser-'));
  try {
    console.log(`browser check: using ${chrome}`);
    checkPublishedPage(chrome, work);
    checkExtension(chrome, work);
  } catch (err) {
    failures.push(`the browser check itself threw: ${err.message}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  for (const note of notes) console.log(`  ${note}`);
  if (failures.length) {
    console.error(`BROWSER CHECK FAILED: ${failures.length} problem(s)`);
    for (const f of failures) console.error(`  ${f}`);
    return 1;
  }
  if (notes.length < 3) {
    console.error('BROWSER CHECK FAILED: fewer measurements were taken than expected, so the check '
      + 'returned early without asserting what it claims to assert');
    return 1;
  }
  console.log('BROWSER CHECK PASSED');
  return 0;
}

process.exitCode = main();
