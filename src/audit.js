// Whole document audit. Every entry it produces is a number or a quoted piece of the
// document, so a later run can be diffed against an earlier one.

import { parseHTML, walk, byTag, findAll, textContent } from './html/parse.js';
import { parseStylesheet } from './css.js';
import { computeStyles } from './style.js';
import { contrastRatio, requiredRatio, toHex, isLargeText } from './color.js';
import { auditImages } from './alt.js';
import { measureReadingOrder, isLayoutTable, ownText, NON_RENDERED, BLOCK_TAGS } from './readingorder.js';

// WCAG 1.4.12 Text Spacing, the values content must stay readable at. The remediated
// document is authored at these values rather than merely tolerating them.
export const TEXT_SPACING = {
  lineHeight: 1.5,
  letterSpacingEm: 0.12,
  wordSpacingEm: 0.16,
  paragraphSpacingEm: 2
};
export const MIN_BODY_PX = 16;
export const MAX_LINE_CH = 80;

function nodePath(node) {
  const parts = [];
  let cur = node;
  while (cur && cur.type === 'element') {
    const parent = cur.parent;
    if (!parent) { parts.unshift(cur.tag); break; }
    const siblings = parent.children.filter((c) => c.type === 'element' && c.tag === cur.tag);
    const idx = siblings.indexOf(cur) + 1;
    parts.unshift(siblings.length > 1 ? `${cur.tag}[${idx}]` : cur.tag);
    cur = parent;
  }
  return parts.join('>');
}

export function collectStylesheet(root) {
  // Read the raw child text of each <style>, not textContent, which deliberately skips the
  // contents of style and script so stylesheet source never leaks into a document's text.
  const css = byTag(root, 'style')
    .map((s) => s.children.filter((c) => c.type === 'text').map((c) => c.value).join(''))
    .join('\n');
  const sheet = parseStylesheet(css);
  const external = findAll(root, (n) => n.type === 'element' && n.tag === 'link'
    && (n.attrs.rel || '').toLowerCase().includes('stylesheet'));
  for (const link of external) {
    sheet.warnings.push(`external stylesheet not fetched, colours in it were not measured: ${link.attrs.href || '(no href)'}`);
  }
  return sheet;
}

export function auditDocument(html, options = {}) {
  const root = parseHTML(html);
  const sheet = collectStylesheet(root);
  const { styles, warnings, pageBackground } = computeStyles(root, sheet, options);

  const textRuns = [];
  walk(root, (node) => {
    if (node.type !== 'element') return;
    if (NON_RENDERED.has(node.tag)) return;
    const st = styles.get(node);
    if (!st || st.hidden) return;
    // A run is the text painted directly by this element. Text inside a child <span> belongs
    // to the span, which is the element whose colour and size the browser actually uses.
    // Attributing it to every ancestor as well would count one sentence three times and
    // report a bold span inside an <h2> as a heading faked by styling.
    const text = node.children
      .filter((c) => c.type === 'text')
      .map((c) => c.value)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === '') return;
    let insideHeading = false;
    let insideLink = false;
    let blockTag = null;
    for (let p = node.parent; p; p = p.parent) {
      if (p.type !== 'element') continue;
      if (/^h[1-6]$/.test(p.tag)) insideHeading = true;
      if (p.tag === 'a' || p.tag === 'button' || p.tag === 'label') insideLink = true;
      if (blockTag === null && BLOCK_TAGS.has(p.tag)) blockTag = p.tag;
    }
    if (/^h[1-6]$/.test(node.tag)) insideHeading = true;
    const required = requiredRatio(st.fontSizePx, st.fontWeight);
    const ratio = contrastRatio(st.color, st.background);
    textRuns.push({
      path: nodePath(node),
      tag: node.tag,
      sample: text.slice(0, 60),
      chars: text.length,
      foreground: toHex(st.color),
      background: toHex(st.background),
      fontSizePx: Number(st.fontSizePx.toFixed(2)),
      fontWeight: st.fontWeight,
      large: isLargeText(st.fontSizePx, st.fontWeight),
      required,
      ratio: Number(ratio.toFixed(4)),
      pass: ratio >= required,
      textAlign: st.textAlign,
      lineHeight: Number(st.lineHeight.toFixed(3)),
      letterSpacingEm: Number(st.letterSpacingEm.toFixed(4)),
      wordSpacingEm: Number(st.wordSpacingEm.toFixed(4)),
      fontFamily: st.fontFamily,
      insideHeading,
      insideLink,
      blockTag
    });
  });

  const failing = textRuns.filter((r) => !r.pass);
  const ratios = textRuns.map((r) => r.ratio);
  const images = auditImages(root);

  const headings = byTag(root, 'h1').concat(byTag(root, 'h2'), byTag(root, 'h3'), byTag(root, 'h4'), byTag(root, 'h5'), byTag(root, 'h6'));
  const headingSequence = [];
  walk(root, (n) => {
    if (n.type === 'element' && /^h[1-6]$/.test(n.tag)) {
      headingSequence.push({ level: Number(n.tag[1]), text: textContent(n).replace(/\s+/g, ' ').trim().slice(0, 60) });
    }
  });
  const headingSkips = [];
  for (let i = 1; i < headingSequence.length; i += 1) {
    if (headingSequence[i].level - headingSequence[i - 1].level > 1) {
      headingSkips.push(`${headingSequence[i - 1].level} to ${headingSequence[i].level} at "${headingSequence[i].text}"`);
    }
  }

  // A visual heading is a short line styled to look like a heading while being marked up as
  // ordinary text, so nothing can navigate to it.
  const bodySize = (() => {
    const sizes = textRuns.filter((r) => r.chars > 80).map((r) => r.fontSizePx);
    if (sizes.length === 0) return MIN_BODY_PX;
    sizes.sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)];
  })();
  // Cells, captions, links and form labels are short and often bold by default, and they are
  // not headings. Counting them would turn every data table into five false findings.
  const NOT_A_HEADING = new Set(['th', 'td', 'caption', 'a', 'label', 'legend', 'summary',
    'dt', 'figcaption', 'button', 'option']);
  // A bold line inside a table cell can still be a heading the author faked, so a cell
  // ancestor is not a reason to skip. Text that IS the cell, the caption, or the link is.
  const visualHeadings = textRuns.filter((r) => !r.insideHeading
    && !r.insideLink
    && !NOT_A_HEADING.has(r.tag)
    && r.chars <= 80
    && !/[.:;,]$/.test(r.sample.trim())
    && (r.fontWeight >= 700 || r.fontSizePx >= bodySize * 1.15));

  const justified = textRuns.filter((r) => r.textAlign === 'justify');
  // Headings are excluded from the 1.5 line height count: a display size heading set at 1.3
  // is normal typography, and WCAG 1.4.12 is about paragraph text staying readable when a
  // reader forces wider spacing.
  const tightLines = textRuns.filter((r) => !r.insideHeading && r.lineHeight < TEXT_SPACING.lineHeight);
  const smallText = textRuns.filter((r) => r.fontSizePx < MIN_BODY_PX);
  const tightTracking = textRuns.filter((r) => r.letterSpacingEm < TEXT_SPACING.letterSpacingEm);
  const allCaps = textRuns.filter((r) => r.chars >= 25 && r.sample === r.sample.toUpperCase() && /[A-Z]{6,}/.test(r.sample));

  const tables = byTag(root, 'table');
  const layoutTables = tables.filter(isLayoutTable);

  const htmlEl = findAll(root, (n) => n.type === 'element' && n.tag === 'html')[0];
  const lang = htmlEl ? (htmlEl.attrs.lang || null) : null;
  const titleEl = byTag(root, 'title')[0];

  const readingOrder = options.expectedOrder && options.expectedOrder.length
    ? measureReadingOrder(root, options.expectedOrder)
    : null;

  return {
    root,
    styles,
    stylesheet: sheet,
    pageBackground: toHex(pageBackground),
    warnings: [...sheet.warnings, ...warnings],
    textRuns,
    summary: {
      textRuns: textRuns.length,
      failingContrast: failing.length,
      minContrast: ratios.length ? Number(Math.min(...ratios).toFixed(4)) : null,
      medianContrast: ratios.length ? Number([...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)].toFixed(4)) : null,
      worst: failing.length
        ? failing.slice().sort((a, b) => a.ratio - b.ratio)[0]
        : null,
      images: {
        total: images.total,
        described: images.described,
        declaredDecorative: images.declaredDecorative,
        autoDecorative: images.autoDecorative,
        needsHuman: images.needsHuman,
        resolved: images.resolved
      },
      headings: headings.length,
      headingSkips,
      visualHeadings: visualHeadings.length,
      justifiedRuns: justified.length,
      tightLineHeightRuns: tightLines.length,
      belowMinimumFontRuns: smallText.length,
      tightTrackingRuns: tightTracking.length,
      allCapsRuns: allCaps.length,
      tables: tables.length,
      layoutTables: layoutTables.length,
      lang,
      hasTitle: Boolean(titleEl && textContent(titleEl).trim() !== ''),
      readingOrder: readingOrder
        ? {
          matched: readingOrder.matched,
          missing: readingOrder.missing.length,
          inversions: readingOrder.inversions,
          pairs: readingOrder.pairs,
          tauDistance: Number(readingOrder.tauDistance.toFixed(4))
        }
        : null
    },
    details: {
      images: images.findings.map(({ node, ...rest }) => rest),
      visualHeadings: visualHeadings.map((r) => ({ path: r.path, sample: r.sample })),
      headingSequence,
      readingOrder
    }
  };
}

export function reportToJSON(audit) {
  return {
    pageBackground: audit.pageBackground,
    warnings: audit.warnings,
    summary: audit.summary,
    textRuns: audit.textRuns,
    details: audit.details
  };
}
