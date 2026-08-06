#!/usr/bin/env node
// Build corpus/public-notice.pdf: a deliberately bad two column public notice.
//
// The faults are the ones that show up in real municipal notices produced by a desktop
// publishing template and exported without a thought for accessibility:
//   - 9pt text at 0.63 grey on white, well under any contrast threshold
//   - two columns whose content stream emits left line, right line, left line, so any
//     linearising reader interleaves the two stories
//   - no /StructTreeRoot, so there is no tagged reading order to fall back on
//   - no /Lang, so a screen reader guesses the language
// Regenerating is deterministic, so the committed PDF can be reproduced byte for byte.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'corpus', 'public-notice.pdf');

const LEFT_X = 54;
const RIGHT_X = 324;
const TOP_Y = 720;
const LINE = 12;
const BODY_PT = 9;
const GREY = 0.63;

const title = 'CITY OF RIVERTON NOTICE OF PUBLIC HEARING ON THE WATER RATE SCHEDULE';

const leftParagraphs = [
  ['The city council will hold a public hearing on the',
    'proposed water and sewer rate schedule for the',
    'coming fiscal year. The hearing is open to every',
    'resident and to any person who pays a water bill',
    'inside the city limits.'],
  ['The proposed schedule raises the base monthly',
    'charge and lowers the per gallon charge above the',
    'first four thousand gallons. A household using less',
    'than four thousand gallons a month will pay more',
    'under the proposal than it pays now.'],
  ['Written comments may be filed with the city clerk',
    'until five in the afternoon on the last business day',
    'before the hearing. Comments filed after that time',
    'are entered into the record but are not read aloud.']
];

const rightParagraphs = [
  ['The hearing takes place in the council chamber on',
    'the second floor of city hall. The building has a',
    'ramp at the rear entrance and an elevator to the',
    'second floor.'],
  ['A sign language interpreter and a Spanish language',
    'interpreter are provided at no cost if the clerk is',
    'asked at least five business days in advance.',
    'Assistive listening receivers are kept at the desk.'],
  ['The full rate study, the current schedule, and the',
    'proposed schedule are available for inspection at',
    'the clerk counter during business hours and are',
    'posted on the city notice board in the lobby.']
];

function escapePdfText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function textOp(x, y, size, grey, text) {
  return `BT /F1 ${size} Tf ${grey} g 1 0 0 1 ${x} ${y} Tm (${escapePdfText(text)}) Tj ET`;
}

function buildContent() {
  const ops = [];
  ops.push('1 1 1 rg 0 0 612 792 re f');
  // Title, wrapped by hand so the line breaks are stable.
  ops.push(textOp(LEFT_X, 756, 13, 0.55, 'CITY OF RIVERTON NOTICE OF PUBLIC HEARING'));
  ops.push(textOp(LEFT_X, 740, 13, 0.55, 'ON THE WATER RATE SCHEDULE'));

  // Flatten each column into lines with their y positions, paragraph gaps included.
  const columnLines = (paras, x) => {
    const lines = [];
    let y = TOP_Y - 24;
    for (const para of paras) {
      for (const line of para) {
        lines.push({ x, y, text: line });
        y -= LINE;
      }
      y -= 10; // paragraph gap
    }
    return lines;
  };
  const left = columnLines(leftParagraphs, LEFT_X);
  const right = columnLines(rightParagraphs, RIGHT_X);

  // The defect: the stream alternates between the columns line by line.
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    if (left[i]) ops.push(textOp(left[i].x, left[i].y, BODY_PT, GREY, left[i].text));
    if (right[i]) ops.push(textOp(right[i].x, right[i].y, BODY_PT, GREY, right[i].text));
  }
  return ops.join('\n');
}

function buildPdf() {
  const content = buildContent();
  const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'), { level: 9 });
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  let out = Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1');
  const offsets = [0];
  const push = (buf) => { out = Buffer.concat([out, Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1')]); };

  for (let i = 1; i <= 4; i += 1) {
    offsets[i] = out.length;
    push(`${i} 0 obj\n${objects[i]}\nendobj\n`);
  }
  offsets[5] = out.length;
  push(`5 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`);
  push(compressed);
  push('\nendstream\nendobj\n');

  const xrefPos = out.length;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  // No /Lang and no /StructTreeRoot in the catalog: that is part of the fault being modelled.
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return out;
}

fs.writeFileSync(OUT, buildPdf());
process.stdout.write(`wrote ${OUT} (${fs.statSync(OUT).size} bytes)\n`);
export { buildContent, title };
