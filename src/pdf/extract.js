// Enough of a PDF reader to answer the accessibility questions: what text is on the page,
// where is it, what colour is it painted, and does the order it comes out of the content
// stream match the order a person reads it in.
//
// Scope, stated plainly. It reads uncompressed and FlateDecode content streams with the
// standard 14 fonts and WinAnsi style single byte text. It does not do CID fonts, embedded
// subset encodings, OCR of scanned pages, or tagged PDF structure trees. A scanned notice is
// an image, and this tool reports that it cannot read it rather than returning empty text
// that would look like a clean document.

import zlib from 'node:zlib';

function toLatin1(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
}

function parseDict(src) {
  // Shallow key/value scrape of a dictionary body. Good enough for /Type, /Filter,
  // /Contents, /MediaBox, /Length, /Kids.
  const dict = {};
  const re = /\/([A-Za-z0-9#]+)\s*(\[[^\]]*\]|<<[\s\S]*?>>|\/[A-Za-z0-9#]+|\d+\s+\d+\s+R|-?[\d.]+|\([^)]*\))?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    dict[m[1]] = m[2] === undefined ? true : m[2].trim();
  }
  return dict;
}

export function parseObjects(buffer) {
  const src = toLatin1(buffer);
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const endIdx = src.indexOf('endobj', start);
    const body = src.slice(start, endIdx === -1 ? src.length : endIdx);
    const streamIdx = body.indexOf('stream');
    let header = body;
    let stream = null;
    if (streamIdx !== -1) {
      header = body.slice(0, streamIdx);
      let s = streamIdx + 'stream'.length;
      if (body[s] === '\r') s += 1;
      if (body[s] === '\n') s += 1;
      const endStream = body.lastIndexOf('endstream');
      stream = Buffer.from(body.slice(s, endStream === -1 ? body.length : endStream), 'latin1');
    }
    objects.set(num, { num, header, dict: parseDict(header), stream });
  }
  return objects;
}

export function decodeStream(obj) {
  if (!obj || !obj.stream) return null;
  const filter = obj.dict.Filter || '';
  if (filter.includes('FlateDecode')) {
    try {
      return zlib.inflateSync(obj.stream);
    } catch (err) {
      try {
        return zlib.inflateRawSync(obj.stream);
      } catch (err2) {
        throw new Error(`stream in object ${obj.num} is FlateDecode but did not inflate: ${err.message}`);
      }
    }
  }
  if (filter && !filter.includes('FlateDecode')) {
    throw new Error(`unsupported stream filter ${filter} in object ${obj.num}`);
  }
  return obj.stream;
}

// Content stream tokenizer.
export function tokenize(content) {
  const s = content.toString('latin1');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '%') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '(') {
      let depth = 1;
      let out = '';
      i += 1;
      while (i < s.length && depth > 0) {
        const ch = s[i];
        if (ch === '\\') {
          const next = s[i + 1];
          const octal = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
          if (octal) { out += String.fromCharCode(parseInt(octal[0], 8)); i += 1 + octal[0].length; continue; }
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          out += Object.prototype.hasOwnProperty.call(map, next) ? map[next] : next;
          i += 2;
          continue;
        }
        if (ch === '(') { depth += 1; out += ch; i += 1; continue; }
        if (ch === ')') { depth -= 1; if (depth > 0) out += ch; i += 1; continue; }
        out += ch;
        i += 1;
      }
      tokens.push({ type: 'string', value: out });
      continue;
    }
    if (c === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      const hex = s.slice(i + 1, end === -1 ? s.length : end).replace(/\s+/g, '');
      let out = '';
      for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      tokens.push({ type: 'string', value: out });
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (c === '<' && s[i + 1] === '<') { tokens.push({ type: 'dictopen' }); i += 2; continue; }
    if (c === '>' && s[i + 1] === '>') { tokens.push({ type: 'dictclose' }); i += 2; continue; }
    if (c === '[') { tokens.push({ type: 'arrayopen' }); i += 1; continue; }
    if (c === ']') { tokens.push({ type: 'arrayclose' }); i += 1; continue; }
    if (c === '/') {
      const m = s.slice(i + 1).match(/^[^\s/[\]()<>]*/);
      tokens.push({ type: 'name', value: m ? m[0] : '' });
      i += 1 + (m ? m[0].length : 0);
      continue;
    }
    const numMatch = s.slice(i).match(/^[-+]?[\d.]+/);
    if (numMatch && /[\d.]/.test(c.replace('-', '0'))) {
      tokens.push({ type: 'number', value: parseFloat(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }
    if (numMatch && (c === '-' || c === '+')) {
      tokens.push({ type: 'number', value: parseFloat(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }
    const opMatch = s.slice(i).match(/^[A-Za-z'"*][A-Za-z0-9'"*]*/);
    if (opMatch) { tokens.push({ type: 'op', value: opMatch[0] }); i += opMatch[0].length; continue; }
    i += 1;
  }
  return tokens;
}

function hex(n) { return Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0'); }
function rgbHex(r, g, b) { return `#${hex(r)}${hex(g)}${hex(b)}`; }

function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ];
}

export function runContentStream(content, mediaBox) {
  const tokens = tokenize(content);
  const stack = [];
  const runs = [];
  const rects = [];
  let fill = { r: 0, g: 0, b: 0 };
  let fontSize = 12;
  let leading = 0;
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = tm.slice();
  const pageArea = Math.abs((mediaBox[2] - mediaBox[0]) * (mediaBox[3] - mediaBox[1]));

  const nums = (count) => stack.slice(-count).map((t) => (t && t.type === 'number' ? t.value : 0));

  const show = (text) => {
    if (text === '') return;
    const size = fontSize * Math.abs(tm[3] || 1);
    runs.push({
      text,
      x: tm[4],
      y: tm[5],
      fontSizePt: Number(size.toFixed(2)),
      color: rgbHex(fill.r, fill.g, fill.b),
      streamIndex: runs.length
    });
    // Advance roughly by the width of the shown text so two Tj on the same line do not land
    // on the same x. Helvetica averages near 0.5 em across mixed case text.
    tm = multiply([1, 0, 0, 1, text.length * size * 0.5, 0], tm);
  };

  for (const token of tokens) {
    if (token.type !== 'op') { stack.push(token); continue; }
    const op = token.value;
    switch (op) {
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
      case 'ET': break;
      case 'Tf': { const [size] = nums(1); fontSize = size; break; }
      case 'TL': { const [l] = nums(1); leading = l; break; }
      case 'Td': { const [tx, ty] = nums(2); tlm = multiply([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); break; }
      case 'TD': { const [tx, ty] = nums(2); leading = -ty; tlm = multiply([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); break; }
      case 'Tm': { const m = nums(6); tlm = m.slice(); tm = m.slice(); break; }
      case 'T*': { tlm = multiply([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); break; }
      case 'Tj': { const t = stack[stack.length - 1]; if (t && t.type === 'string') show(t.value); break; }
      case "'": { tlm = multiply([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); const t = stack[stack.length - 1]; if (t && t.type === 'string') show(t.value); break; }
      case '"': { tlm = multiply([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); const t = stack[stack.length - 1]; if (t && t.type === 'string') show(t.value); break; }
      case 'TJ': {
        let text = '';
        let started = false;
        const items = [];
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].type === 'arrayopen') { started = true; break; }
          items.unshift(stack[i]);
        }
        if (started) {
          for (const item of items) {
            if (item.type === 'string') text += item.value;
            else if (item.type === 'number' && item.value <= -120) text += ' ';
          }
        }
        show(text);
        break;
      }
      case 'g': { const [v] = nums(1); fill = { r: v, g: v, b: v }; break; }
      case 'rg': { const [r, g, b] = nums(3); fill = { r, g, b }; break; }
      case 'k': {
        const [c, m2, y2, k2] = nums(4);
        fill = { r: (1 - c) * (1 - k2), g: (1 - m2) * (1 - k2), b: (1 - y2) * (1 - k2) };
        break;
      }
      case 're': { const [x, y, w, h] = nums(4); rects.push({ x, y, w, h, color: rgbHex(fill.r, fill.g, fill.b), area: Math.abs(w * h) }); break; }
      case 'f':
      case 'F':
      case 'f*': break;
      default: break;
    }
    if (op !== 'Tf' && op !== 'TL') stack.length = 0;
    else stack.length = 0;
  }

  const backgroundRect = rects
    .filter((r) => r.area >= pageArea * 0.8)
    .slice(-1)[0];
  return { runs, rects, background: backgroundRect ? backgroundRect.color : '#ffffff' };
}

// Columns by the widest horizontal gap between run start positions. A gap wider than a fifth
// of the page with text on both sides is a column break.
export function detectColumns(runs, mediaBox) {
  if (runs.length === 0) return [];
  const pageWidth = mediaBox[2] - mediaBox[0];
  const xs = [...new Set(runs.map((r) => Number(r.x.toFixed(1))))].sort((a, b) => a - b);
  let split = null;
  let widest = 0;
  for (let i = 1; i < xs.length; i += 1) {
    const gap = xs[i] - xs[i - 1];
    if (gap > widest) { widest = gap; split = xs[i]; }
  }
  if (split === null || widest < pageWidth * 0.2) {
    return [{ left: Math.min(...xs), runs: runs.slice() }];
  }
  const leftRuns = runs.filter((r) => r.x < split);
  const rightRuns = runs.filter((r) => r.x >= split);
  if (leftRuns.length < 2 || rightRuns.length < 2) return [{ left: Math.min(...xs), runs: runs.slice() }];
  return [
    { left: Math.min(...leftRuns.map((r) => r.x)), runs: leftRuns },
    { left: Math.min(...rightRuns.map((r) => r.x)), runs: rightRuns }
  ];
}

function countInversions(indices) {
  let inversions = 0;
  let pairs = 0;
  for (let i = 0; i < indices.length; i += 1) {
    for (let j = i + 1; j < indices.length; j += 1) {
      pairs += 1;
      if (indices[i] > indices[j]) inversions += 1;
    }
  }
  return { inversions, pairs };
}

// Group runs of one column into paragraphs: a vertical gap larger than one and a half line
// heights, or a font size change, starts a new paragraph.
function paragraphs(columnRuns) {
  const out = [];
  let current = null;
  let prev = null;
  for (const run of columnRuns) {
    const gap = prev ? prev.y - run.y : 0;
    const newPara = !current
      || (prev && Math.abs(run.fontSizePt - prev.fontSizePt) > 0.6)
      || (prev && gap > prev.fontSizePt * 1.8);
    if (newPara) {
      current = { text: run.text, fontSizePt: run.fontSizePt, color: run.color, x: run.x, y: run.y, runs: [run] };
      out.push(current);
    } else {
      current.text = `${current.text} ${run.text}`.replace(/\s+/g, ' ');
      current.runs.push(run);
    }
    prev = run;
  }
  return out;
}

export function extractPdf(buffer) {
  const objects = parseObjects(buffer);
  const pageObjs = [...objects.values()].filter((o) => /\/Type\s*\/Page\b/.test(o.header));
  if (pageObjs.length === 0) throw new Error('no page objects found, this file may not be a PDF this tool can read');
  const pages = [];
  let imageOnly = 0;

  pageObjs.forEach((pageObj, index) => {
    const boxMatch = (pageObj.header.match(/\/MediaBox\s*\[([^\]]*)\]/) || [])[1];
    const mediaBox = boxMatch ? boxMatch.trim().split(/\s+/).map(Number) : [0, 0, 612, 792];
    const contentRefs = (pageObj.header.match(/\/Contents\s*(\d+)\s+\d+\s+R/) || [])[1];
    const arrayRefs = (pageObj.header.match(/\/Contents\s*\[([^\]]*)\]/) || [])[1];
    const refNums = [];
    if (contentRefs) refNums.push(Number(contentRefs));
    if (arrayRefs) for (const m of arrayRefs.matchAll(/(\d+)\s+\d+\s+R/g)) refNums.push(Number(m[1]));
    let content = Buffer.alloc(0);
    for (const num of refNums) {
      const decoded = decodeStream(objects.get(num));
      if (decoded) content = Buffer.concat([content, decoded, Buffer.from('\n')]);
    }
    const { runs, background } = runContentStream(content, mediaBox);
    const hasImages = /\/Subtype\s*\/Image/.test(pageObj.header) || [...objects.values()].some((o) => /\/Subtype\s*\/Image/.test(o.header));
    if (runs.length === 0 && hasImages) imageOnly += 1;

    const columns = detectColumns(runs, mediaBox);
    const readingOrder = [];
    for (const col of columns) {
      const sorted = col.runs.slice().sort((a, b) => (Math.abs(b.y - a.y) > 0.5 ? b.y - a.y : a.x - b.x));
      readingOrder.push(...sorted);
    }
    const { inversions, pairs } = countInversions(readingOrder.map((r) => r.streamIndex));
    pages.push({
      number: index + 1,
      mediaBox,
      background,
      runs,
      columns: columns.map((c) => ({ left: Number(c.left.toFixed(1)), runs: c.runs.length })),
      readingOrder,
      paragraphs: columns.flatMap((col) => paragraphs(col.runs.slice().sort((a, b) => (Math.abs(b.y - a.y) > 0.5 ? b.y - a.y : a.x - b.x)))),
      streamOrderInversions: inversions,
      streamOrderPairs: pairs,
      textRuns: runs.length,
      imageOnly: runs.length === 0 && hasImages
    });
  });

  return {
    pages,
    tagged: /\/StructTreeRoot/.test(toLatin1(buffer)),
    lang: (toLatin1(buffer).match(/\/Lang\s*\(([^)]*)\)/) || [])[1] || null,
    imageOnlyPages: imageOnly
  };
}

// Reflow an extracted PDF into HTML that carries the colours and sizes the PDF actually used,
// so the same contrast measurement runs over PDF and HTML documents through one code path.
export function pdfToHTML(extracted, title = 'document.pdf', options = {}) {
  // order: 'reading' groups each column into paragraphs top to bottom, which is what a person
  // reads. order: 'stream' emits the runs in the order the content stream drew them, which is
  // what a linearising tool without column detection produces. The second is the baseline the
  // first is measured against.
  const order = options.order === 'stream' ? 'stream' : 'reading';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = [`<!DOCTYPE html>`, `<html${extracted.lang ? ` lang="${esc(extracted.lang)}"` : ''}>`, '<head>',
    `<title>${esc(title)}</title>`, '</head>'];
  const bg = extracted.pages.length ? extracted.pages[0].background : '#ffffff';
  parts.push(`<body style="background-color: ${esc(bg)}; text-align: justify; font-family: Helvetica, Arial, sans-serif">`);
  for (const page of extracted.pages) {
    if (page.imageOnly) {
      parts.push(`<p data-pdf-page="${page.number}" style="color: #000000">This page contains no extractable text. It is probably a scan, and it needs optical character recognition before it can be remediated. This tool did not invent text for it.</p>`);
      continue;
    }
    const blocks = order === 'stream'
      ? page.runs.slice().sort((a, b) => a.streamIndex - b.streamIndex)
      : page.paragraphs;
    for (const para of blocks) {
      const px = (para.fontSizePt * 96 / 72).toFixed(1);
      parts.push(`<p style="color: ${esc(para.color)}; font-size: ${px}px">${esc(para.text)}</p>`);
    }
  }
  parts.push('</body>', '</html>');
  return `${parts.join('\n')}\n`;
}
