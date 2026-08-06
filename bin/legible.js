#!/usr/bin/env node
// legible: audit and remediate documents for dyslexic and low vision readers.
//
//   legible audit  <file.html|file.pdf> [--order <file>] [--json]
//   legible fix    <file.html|file.pdf> --out <file.html> [--face atkinson|opendyslexic]
//                                       [--order <file>] [--summary] [--model <name>]
//   legible pdf-text <file.pdf> [--json]
//
// Exit codes: 0 the command ran and its own assertions held, 1 a failure worth acting on,
// 2 a usage error.

import fs from 'node:fs';
import path from 'node:path';
import { auditDocument, reportToJSON } from '../src/audit.js';
import { remediateHTML, textPreserved, REPAIR_TARGET } from '../src/remediate.js';
import { readGroundTruth } from '../src/readingorder.js';
import { extractPdf, pdfToHTML } from '../src/pdf/extract.js';
import { summarize } from '../src/summary.js';

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[key] = true;
      else { out.flags[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function loadDocument(file, flags = {}) {
  const raw = fs.readFileSync(file);
  if (path.extname(file).toLowerCase() === '.pdf') {
    const extracted = extractPdf(raw);
    const order = flags['pdf-order'] === 'stream' ? 'stream' : 'reading';
    return { html: pdfToHTML(extracted, path.basename(file), { order }), pdf: extracted };
  }
  return { html: raw.toString('utf8'), pdf: null };
}

function orderFor(file, flags) {
  if (flags.order && flags.order !== true) return readGroundTruth(fs.readFileSync(flags.order, 'utf8'));
  const guess = file.replace(/\.(html?|pdf)$/i, '.order.txt');
  if (guess !== file && fs.existsSync(guess)) return readGroundTruth(fs.readFileSync(guess, 'utf8'));
  return [];
}

function fmtRatio(n) { return n === null || n === undefined ? 'n/a' : `${n.toFixed(2)}:1`; }

function printAudit(label, audit) {
  const s = audit.summary;
  console.log(`\n${label}`);
  console.log(`  text runs measured        ${s.textRuns}`);
  console.log(`  contrast failures         ${s.failingContrast} of ${s.textRuns}`);
  console.log(`  minimum contrast          ${fmtRatio(s.minContrast)}${s.worst ? `  (${s.worst.foreground} on ${s.worst.background}, ${s.worst.fontSizePx}px, needs ${s.worst.required}:1, "${s.worst.sample.slice(0, 40)}")` : ''}`);
  console.log(`  median contrast           ${fmtRatio(s.medianContrast)}`);
  console.log(`  justified runs            ${s.justifiedRuns}`);
  console.log(`  line height below 1.5     ${s.tightLineHeightRuns}`);
  console.log(`  tracking below 0.12em     ${s.tightTrackingRuns}`);
  console.log(`  text below 16px           ${s.belowMinimumFontRuns}`);
  console.log(`  all caps runs             ${s.allCapsRuns}`);
  console.log(`  real headings             ${s.headings}${s.headingSkips.length ? `, level skips: ${s.headingSkips.join('; ')}` : ''}`);
  console.log(`  headings faked by styling ${s.visualHeadings}`);
  console.log(`  layout tables             ${s.layoutTables} of ${s.tables} tables`);
  console.log(`  images                    ${s.images.total} total, ${s.images.described} described, ${s.images.declaredDecorative} declared decorative, ${s.images.autoDecorative} decorative from evidence, ${s.images.needsHuman} need a human`);
  console.log(`  html lang                 ${s.lang || 'MISSING'}`);
  console.log(`  document title            ${s.hasTitle ? 'present' : 'MISSING'}`);
  if (s.readingOrder) {
    console.log(`  reading order             ${s.readingOrder.inversions} inverted pairs of ${s.readingOrder.pairs} (tau distance ${s.readingOrder.tauDistance.toFixed(3)}), ${s.readingOrder.matched} blocks matched, ${s.readingOrder.missing} not found`);
  } else {
    console.log('  reading order             not measured, no ground truth order file given');
  }
  for (const w of audit.warnings) console.log(`  warning: ${w}`);
}

async function cmdAudit(args) {
  const file = args._[1];
  if (!file) { console.error('usage: legible audit <file> [--order <file>] [--json]'); return 2; }
  const { html, pdf } = loadDocument(file, args.flags);
  const audit = auditDocument(html, { expectedOrder: orderFor(file, args.flags) });
  if (args.flags.json) {
    console.log(JSON.stringify(reportToJSON(audit), null, 2));
    return 0;
  }
  printAudit(`audit: ${file}${args.flags['pdf-order'] === 'stream' ? ' (reflowed in content stream order)' : ''}`, audit);
  if (pdf) {
    for (const page of pdf.pages) {
      console.log(`  pdf page ${page.number}          ${page.textRuns} text runs, ${page.columns.length} column(s), content stream order differs from reading order in ${page.streamOrderInversions} of ${page.streamOrderPairs} pairs`);
    }
    console.log(`  pdf tagged structure      ${pdf.tagged ? 'present' : 'MISSING, there is no author supplied reading order to fall back on'}`);
    console.log(`  pdf /Lang                 ${pdf.lang || 'MISSING'}`);
    if (pdf.imageOnlyPages) console.log(`  pdf pages with no text    ${pdf.imageOnlyPages}, these need optical character recognition and this tool did not invent text for them`);
  }
  return 0;
}

async function cmdFix(args) {
  const file = args._[1];
  const out = args.flags.out || args.flags.o;
  if (!file || !out || out === true) { console.error('usage: legible fix <file> --out <file.html> [--face atkinson|opendyslexic] [--summary]'); return 2; }
  const { html } = loadDocument(file, args.flags);
  const expectedOrder = orderFor(file, args.flags);

  let summary = null;
  if (args.flags.summary) {
    const result = await summarize(html, {
      model: args.flags.model && args.flags.model !== true ? args.flags.model : undefined,
      endpoint: process.env.LEGIBLE_LLM_ENDPOINT
    });
    if (!result.ok) {
      console.error(`plain language summary failed: ${result.error}`);
      console.error('the document was not written, because a partial run should not look like a complete one');
      return 1;
    }
    summary = { title: 'Plain language summary', paragraphs: result.paragraphs, disclaimer: result.disclaimer };
  }

  const result = remediateHTML(html, {
    face: args.flags.face && args.flags.face !== true ? args.flags.face : 'atkinson',
    lang: args.flags.lang && args.flags.lang !== true ? args.flags.lang : 'en',
    expectedOrder,
    summary
  });
  fs.writeFileSync(out, result.html);

  const preserved = textPreserved(html, result.html);
  printAudit(`before: ${file}`, result.before);
  printAudit(`after:  ${out}`, result.after);
  console.log('\nwhat changed');
  for (const a of result.report.actions) console.log(`  - ${a}`);
  const needsHuman = result.report.images.flags.filter((f) => f.status === 'needs-human');
  if (needsHuman.length) {
    console.log('\nwhat this tool could not do');
    for (const f of needsHuman) console.log(`  - ${f.src || '(no src)'}: ${f.reason}`);
    console.log('    no alt text was invented for these. A person has to look at the image and write it.');
  }
  console.log(`\noriginal wording preserved: ${preserved.preserved ? 'yes' : `NO, ${preserved.missing.length} words missing`}`);
  if (!preserved.preserved) {
    console.log(`  missing: ${preserved.missing.slice(0, 12).join(' ')}`);
    return 1;
  }
  if (result.after.summary.failingContrast > 0) {
    console.log(`\nFAIL: ${result.after.summary.failingContrast} text run(s) still below the required ratio after remediation`);
    return 1;
  }
  if (result.after.summary.minContrast < REPAIR_TARGET) {
    console.log(`\nFAIL: minimum contrast after remediation is ${fmtRatio(result.after.summary.minContrast)}, below the ${REPAIR_TARGET}:1 target`);
    return 1;
  }
  return 0;
}

async function cmdPdfText(args) {
  const file = args._[1];
  if (!file) { console.error('usage: legible pdf-text <file.pdf> [--json]'); return 2; }
  const extracted = extractPdf(fs.readFileSync(file));
  if (args.flags.json) { console.log(JSON.stringify(extracted, null, 2)); return 0; }
  console.log(`pages: ${extracted.pages.length}`);
  for (const page of extracted.pages) {
    console.log(`\npage ${page.number}: ${page.runs.length} text runs, ${page.columns.length} column(s) detected`);
    console.log(`  stream order differs from reading order in ${page.streamOrderInversions} of ${page.streamOrderPairs} pairs`);
    for (const run of page.readingOrder) {
      console.log(`  [${run.x.toFixed(0)},${run.y.toFixed(0)} ${run.fontSizePt}pt ${run.color}] ${run.text.slice(0, 70)}`);
    }
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    if (cmd === 'audit') return await cmdAudit(args);
    if (cmd === 'fix') return await cmdFix(args);
    if (cmd === 'pdf-text') return await cmdPdfText(args);
  } catch (err) {
    console.error(`error: ${err.message}`);
    if (process.env.LEGIBLE_DEBUG) console.error(err.stack);
    return 1;
  }
  console.error('usage: legible <audit|fix|pdf-text> ...');
  return 2;
}

main().then((code) => { process.exitCode = code; });
