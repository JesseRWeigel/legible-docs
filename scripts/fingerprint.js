#!/usr/bin/env node
// Print a canonical JSON summary of everything this tool measures, for the corpus in this
// checkout.
//
// The output is the input to scripts/sabotage.py, which asks of every attack: did the measured
// output change? For that question to mean anything the fingerprint has to depend on the CODE
// and on nothing else. So:
//
//   - no absolute paths anywhere, not in a key, not in a value, not in a warning string
//   - documents are visited in sorted basename order, never in directory order
//   - no timestamps, no process ids, no environment, no random numbers
//   - every number is rounded to a fixed number of places, so a change in the last float bit
//     of an unrelated computation does not masquerade as a caught sabotage
//
// A fingerprint that varies with the working directory makes gate 2 of the three-gate rule
// pass for free, and then every sabotage scores as proven while proving nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { auditDocument } from '../src/audit.js';
import { remediateHTML, textPreserved } from '../src/remediate.js';
import { readGroundTruth } from '../src/readingorder.js';
import { extractPdf, pdfToHTML } from '../src/pdf/extract.js';
import { parseColor, contrastRatio, requiredRatio, isLargeText } from '../src/color.js';
import { repairPair, shadeBand } from '../src/repair.js';
import { classifyImage } from '../src/alt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, '..', 'corpus');

const r4 = (n) => (n === null || n === undefined ? null : Number(Number(n).toFixed(4)));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function orderFor(base) {
  const file = path.join(CORPUS, `${base.replace(/\.(html?|pdf)$/i, '')}.order.txt`);
  return fs.existsSync(file) ? readGroundTruth(fs.readFileSync(file, 'utf8')) : [];
}

// Only the fields that are measurements. `warnings` is included because "this colour could not
// be read" is itself a finding, but the strings are sorted and stripped of anything path-like.
function summaryOf(audit) {
  const s = audit.summary;
  return {
    textRuns: s.textRuns,
    failingContrast: s.failingContrast,
    minContrast: r4(s.minContrast),
    medianContrast: r4(s.medianContrast),
    justifiedRuns: s.justifiedRuns,
    tightLineHeightRuns: s.tightLineHeightRuns,
    tightTrackingRuns: s.tightTrackingRuns,
    belowMinimumFontRuns: s.belowMinimumFontRuns,
    allCapsRuns: s.allCapsRuns,
    headings: s.headings,
    headingSkips: s.headingSkips.length,
    visualHeadings: s.visualHeadings,
    tables: s.tables,
    layoutTables: s.layoutTables,
    lang: s.lang,
    hasTitle: s.hasTitle,
    images: s.images,
    readingOrder: s.readingOrder
      ? {
        matched: s.readingOrder.matched,
        missing: s.readingOrder.missing,
        inversions: s.readingOrder.inversions,
        pairs: s.readingOrder.pairs,
        tauDistance: r4(s.readingOrder.tauDistance)
      }
      : null,
    warnings: audit.warnings.slice().sort()
  };
}

// Every text run, so a sabotage that shifts one colour on one element cannot hide inside an
// aggregate that happens to round the same way.
function runsOf(audit) {
  return audit.textRuns
    .map((run) => [run.tag, run.sample, run.foreground, run.background, r4(run.fontSizePx),
      run.fontWeight, run.large, run.required, r4(run.ratio), run.pass, run.textAlign,
      r4(run.lineHeight), r4(run.letterSpacingEm)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function documentEntry(base, html) {
  const expectedOrder = orderFor(base);
  const before = auditDocument(html, { expectedOrder });
  const result = remediateHTML(html, { expectedOrder });
  const after = auditDocument(result.html, { expectedOrder });
  const preserved = textPreserved(html, result.html);
  const repairs = result.report.colorRepairs;
  return {
    before: summaryOf(before),
    beforeRuns: runsOf(before),
    after: summaryOf(after),
    afterRuns: runsOf(after),
    preserved: { ok: preserved.preserved, sourceWords: preserved.sourceWords, missing: preserved.missing.length },
    report: {
      actions: result.report.actions.length,
      colorRepairs: repairs.length,
      colorRepairsChanged: repairs.filter((x) => x.changed).length,
      colorRepairsMet: repairs.filter((x) => x.met).length,
      minRatioAfter: repairs.length ? r4(Math.min(...repairs.map((x) => x.ratioAfter))) : null,
      band: { hex: result.report.band.hex, bandContrast: r4(result.report.band.bandContrast), textContrast: r4(result.report.band.textContrast) },
      shaded: result.report.shading.shaded,
      paragraphs: result.report.shading.paragraphs,
      headingsPromoted: result.report.headingsPromoted.length,
      headingsNotPromoted: result.report.headingsNotPromoted.length,
      layoutTablesUnwrapped: result.report.layoutTablesUnwrapped,
      images: result.report.images.counts,
      summaryInserted: result.report.summaryInserted
    },
    // The remediated document itself, hashed. Anything that changes a single byte of the
    // deliverable moves this, including changes the summary numbers would not notice.
    outputSha: sha(result.html),
    outputBytes: result.html.length
  };
}

// A fixed probe table over the pure functions. Corpus documents exercise them in combination;
// this exercises them directly, so a sabotage to one branch of the contrast maths shows up
// even if no corpus document happens to reach that branch.
function probes() {
  const pairs = [['#000000', '#ffffff'], ['#767676', '#ffffff'], ['#777777', '#ffffff'],
    ['#949494', '#ffffff'], ['#bfbfbf', '#f0f0f0'], ['#bcbcbc', '#ffffff'], ['#8fb4d9', '#ffffff'],
    ['#1a1a1a', '#ffffff'], ['#0000ff', '#ffffff'], ['#008000', '#ffffff'], ['#808080', '#000000'],
    ['#0a0a0a', '#ffffff'], ['#0b0b0b', '#ffffff'], ['#3a3a3a', '#000000'], ['#eef1f5', '#ffffff']];
  const contrast = pairs.map(([a, b]) => [a, b, r4(contrastRatio(parseColor(a), parseColor(b)))]);

  const sizes = [[9, 400], [11, 400], [15.99, 400], [16, 400], [18.66, 700], [18.67, 700],
    [23.99, 400], [24, 400], [20, 600], [20, 700], [32, 400]];
  const large = sizes.map(([px, w]) => [px, w, isLargeText(px, w), requiredRatio(px, w)]);

  const repairs = [['#949494', '#ffffff', 4.5], ['#bfbfbf', '#f0f0f0', 4.5], ['#808080', '#3a3a3a', 4.5],
    ['#6a8fd8', '#ffffff', 4.5], ['#000000', '#808080', 7], ['#808080', '#808080', 25]]
    .map(([fg, bg, target]) => {
      const out = repairPair(parseColor(fg), parseColor(bg), target);
      return [fg, bg, target, out.direction, out.met, r4(out.ratioAfter)];
    });

  const band = shadeBand(parseColor('#ffffff'), parseColor('#1a1a1a'), 4.5);

  const images = [
    { src: 'a.jpg', alt: null, hasAlt: false, role: '', ariaHidden: false, width: null, height: null },
    { src: 'a.jpg', alt: '', hasAlt: true, role: '', ariaHidden: false, width: null, height: null },
    { src: 'a.jpg', alt: 'image', hasAlt: true, role: '', ariaHidden: false, width: null, height: null },
    { src: 'a.jpg', alt: 'a.jpg', hasAlt: true, role: '', ariaHidden: false, width: null, height: null },
    { src: 'seal.png', alt: 'seal.png', hasAlt: true, role: '', ariaHidden: false, width: null, height: null },
    { src: 'a.jpg', alt: 'ok', hasAlt: true, role: '', ariaHidden: false, width: null, height: null },
    { src: 'a.jpg', alt: 'A ramp at the rear entrance', hasAlt: true, role: '', ariaHidden: false, width: null, height: null },
    { src: 'dot_clear.gif', alt: null, hasAlt: false, role: '', ariaHidden: false, width: null, height: null },
    { src: 'x.gif', alt: null, hasAlt: false, role: '', ariaHidden: false, width: '1', height: '1' },
    { src: 'x.gif', alt: null, hasAlt: false, role: 'presentation', ariaHidden: false, width: null, height: null }
  ].map((img) => [img.src, img.alt, img.width, img.role, classifyImage(img).status]);

  return {
    contrast,
    large,
    repairs,
    band: { hex: band.hex, ok: band.ok, bandContrast: r4(band.bandContrast), textContrast: r4(band.textContrast) },
    images
  };
}

function pdfEntry(base, buffer) {
  const extracted = extractPdf(buffer);
  const expectedOrder = orderFor(base);
  const reading = auditDocument(pdfToHTML(extracted, base, { order: 'reading' }), { expectedOrder });
  const stream = auditDocument(pdfToHTML(extracted, base, { order: 'stream' }), { expectedOrder });
  return {
    pages: extracted.pages.length,
    tagged: extracted.tagged,
    lang: extracted.lang,
    imageOnlyPages: extracted.imageOnlyPages,
    perPage: extracted.pages.map((p) => ({
      number: p.number,
      textRuns: p.textRuns,
      columns: p.columns.length,
      background: p.background,
      streamOrderInversions: p.streamOrderInversions,
      streamOrderPairs: p.streamOrderPairs,
      paragraphs: p.paragraphs.length
    })),
    readingOrderReflow: summaryOf(reading).readingOrder,
    streamOrderReflow: summaryOf(stream).readingOrder,
    reflowContrast: { failing: reading.summary.failingContrast, min: r4(reading.summary.minContrast) },
    // The reflow itself, hashed, so a change in how text is grouped into paragraphs shows.
    readingHtmlSha: sha(pdfToHTML(extracted, base, { order: 'reading' }))
  };
}

function main() {
  const entries = {};
  const names = fs.readdirSync(CORPUS).sort();
  for (const name of names) {
    if (/\.html?$/i.test(name)) {
      entries[name] = documentEntry(name, fs.readFileSync(path.join(CORPUS, name), 'utf8'));
    } else if (/\.pdf$/i.test(name)) {
      entries[name] = pdfEntry(name, fs.readFileSync(path.join(CORPUS, name)));
    }
  }
  if (Object.keys(entries).length < 4) {
    console.error(`fingerprint: only ${Object.keys(entries).length} corpus documents found, expected at least 4`);
    process.exitCode = 1;
    return;
  }
  const out = { schema: 'legible-docs/fingerprint/1', documents: entries, probes: probes() };
  const text = JSON.stringify(out, null, 2);
  // A path leaking in would make the fingerprint track the checkout instead of the code, so
  // the script refuses to emit one rather than letting sabotage.py trust it.
  const leak = text.match(/(\/home\/|\/tmp\/|[A-Za-z]:\\\\|\/Users\/|file:\/\/)/);
  if (leak) {
    console.error(`fingerprint: refusing to emit, output contains a filesystem path near ${JSON.stringify(leak[0])}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${text}\n`);
}

main();
