// Reading order, measured rather than assumed.
//
// The defect this catches is the one that looks fine on screen: a document laid out with a
// table so that two stories sit side by side reads, to a screen reader or to any tool that
// linearises the markup, as row one of story A, row one of story B, row two of story A, and
// so on. The page looks right and linearises wrong.
//
// The measurement needs a ground truth, so every corpus document ships a hand written
// .order.txt listing the sentences in the order a human reads them aloud. The metric is the
// Kendall tau distance between the document's linearised order and that list: the number of
// pairs of blocks that appear in the wrong relative order.

import { walk } from './html/parse.js';

export const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th',
  'blockquote', 'figcaption', 'caption', 'dt', 'dd', 'pre', 'div', 'section', 'article',
  'header', 'footer', 'main', 'aside', 'address', 'label', 'legend', 'summary']);

export function normalizeText(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

// Elements whose text never reaches the reader. <title> is text, and it is not on the page,
// so counting it as a text run would put an unmeasurable colour into the contrast report.
export const NON_RENDERED = new Set(['head', 'title', 'meta', 'link', 'script', 'style',
  'noscript', 'template', 'base']);

// Text belonging to this element and not to a nested block element.
export function ownText(el) {
  let out = '';
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'text') { out += child.value; continue; }
      if (child.type !== 'element') continue;
      if (NON_RENDERED.has(child.tag)) continue;
      if (BLOCK_TAGS.has(child.tag)) continue;
      visit(child);
    }
  };
  visit(el);
  return out;
}

export function linearize(root) {
  const blocks = [];
  walk(root, (node) => {
    if (node.type !== 'element') return;
    if (!BLOCK_TAGS.has(node.tag) || NON_RENDERED.has(node.tag)) return;
    const text = normalizeText(ownText(node));
    if (text === '') return;
    blocks.push({ node, tag: node.tag, text });
  });
  return blocks;
}

export function readGroundTruth(contents) {
  return String(contents)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map(normalizeText);
}

// Kendall tau distance: pairs (i, j) with i before j in the expected order whose positions in
// the observed order are swapped. Counted exhaustively, which is fine at document scale.
export function countInversions(positions) {
  let inversions = 0;
  let pairs = 0;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      pairs += 1;
      if (positions[i] > positions[j]) inversions += 1;
    }
  }
  return { inversions, pairs };
}

export function measureReadingOrder(root, expectedSnippets) {
  const blocks = linearize(root);
  const positions = [];
  const missing = [];
  const used = new Set();
  for (const snippet of expectedSnippets) {
    let found = -1;
    for (let i = 0; i < blocks.length; i += 1) {
      if (used.has(i)) continue;
      if (blocks[i].text.includes(snippet)) { found = i; break; }
    }
    if (found === -1) { missing.push(snippet); continue; }
    used.add(found);
    positions.push(found);
  }
  const { inversions, pairs } = countInversions(positions);
  return {
    blocks: blocks.length,
    matched: positions.length,
    missing,
    inversions,
    pairs,
    tauDistance: pairs === 0 ? 0 : inversions / pairs,
    order: positions
  };
}

// A table is a layout table when it carries no header cells, no caption, no scope or headers
// attributes, and no summary: nothing that says its rows and columns mean anything. A data
// table with real headers is left alone, because rewriting one would destroy information.
export function isLayoutTable(table) {
  let hasTh = false;
  let hasScope = false;
  let hasCaption = false;
  let maxCols = 0;
  walk(table, (n) => {
    if (n.type !== 'element') return;
    if (n.tag === 'th') hasTh = true;
    if (n.attrs && (n.attrs.scope || n.attrs.headers)) hasScope = true;
    if (n.tag === 'caption') hasCaption = true;
    if (n.tag === 'tr') {
      const cols = n.children.filter((c) => c.type === 'element' && (c.tag === 'td' || c.tag === 'th')).length;
      maxCols = Math.max(maxCols, cols);
    }
  });
  const role = (table.attrs && table.attrs.role) || '';
  if (role === 'presentation' || role === 'none') return true;
  return !hasTh && !hasScope && !hasCaption && maxCols >= 2;
}

// Rows of cells for a table, as element references.
export function tableGrid(table) {
  const rows = [];
  walk(table, (n) => {
    if (n.type === 'element' && n.tag === 'tr') {
      rows.push(n.children.filter((c) => c.type === 'element' && (c.tag === 'td' || c.tag === 'th')));
    }
  });
  return rows;
}

// Column major reading order for a layout table: everything in column 0 top to bottom, then
// column 1, and so on. This is what a two column newspaper style layout actually means.
export function columnMajorCells(table) {
  const rows = tableGrid(table);
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const out = [];
  for (let c = 0; c < cols; c += 1) {
    for (const row of rows) {
      if (row[c]) out.push(row[c]);
    }
  }
  return out;
}
