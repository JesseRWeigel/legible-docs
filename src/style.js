// Resolve, for every element, the values that decide legibility: painted text colour, the
// background actually behind it after alpha compositing, computed font size in px, weight,
// alignment, line height, and tracking.

import { parseColor, composite } from './color.js';
import { declaredStyles } from './css.js';

const DEFAULT_FONT_PX = 16;

const UA_FONT_SCALE = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67, small: 0.8125, big: 1.17 };
const UA_BOLD = new Set(['b', 'strong', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const UA_CENTER = new Set(['th', 'caption', 'center']);
// <font size> is 1..7 mapped to the classic scale, still present in documents exported from
// old content management systems.
const FONT_SIZE_ATTR = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
const ABSOLUTE_KEYWORDS = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24,
  'xx-large': 32, smaller: null, larger: null
};

export function lengthToPx(value, parentPx, rootPx = DEFAULT_FONT_PX) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === '') return null;
  if (Object.prototype.hasOwnProperty.call(ABSOLUTE_KEYWORDS, v)) {
    if (ABSOLUTE_KEYWORDS[v] !== null) return ABSOLUTE_KEYWORDS[v];
    return v === 'smaller' ? parentPx * 0.833 : parentPx * 1.2;
  }
  let m = v.match(/^(-?[\d.]+)px$/);
  if (m) return parseFloat(m[1]);
  m = v.match(/^(-?[\d.]+)pt$/);
  if (m) return parseFloat(m[1]) * (96 / 72);
  m = v.match(/^(-?[\d.]+)(em|rem)$/);
  if (m) return parseFloat(m[1]) * (m[2] === 'rem' ? rootPx : parentPx);
  m = v.match(/^(-?[\d.]+)%$/);
  if (m) return (parseFloat(m[1]) / 100) * parentPx;
  m = v.match(/^(-?[\d.]+)$/);
  if (m) return parseFloat(m[1]);
  return null;
}

function weightOf(value, parentWeight) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'bold') return 700;
  if (v === 'normal') return 400;
  if (v === 'bolder') return Math.min(900, parentWeight + 300);
  if (v === 'lighter') return Math.max(100, parentWeight - 300);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function backgroundColorOf(decls) {
  if (decls['background-color']) return parseColor(decls['background-color']);
  if (decls.background) {
    for (const token of decls.background.split(/\s+/)) {
      const c = parseColor(token);
      if (c) return c;
    }
    const fn = decls.background.match(/(rgba?|hsla?)\([^)]*\)/i);
    if (fn) return parseColor(fn[0]);
  }
  return null;
}

export function computeStyles(root, stylesheet, options = {}) {
  const pageBackground = options.pageBackground
    ? parseColor(options.pageBackground)
    : { r: 255, g: 255, b: 255, a: 1 };
  const styles = new Map();
  const warnings = [];

  const inheritedDefault = {
    color: { r: 0, g: 0, b: 0, a: 1 },
    fontSizePx: DEFAULT_FONT_PX,
    fontWeight: 400,
    textAlign: 'start',
    lineHeight: 1.2,
    letterSpacingEm: 0,
    wordSpacingEm: 0,
    fontFamily: 'serif',
    background: pageBackground
  };

  const visit = (node, inherited) => {
    if (node.type !== 'element') {
      if (node.type === 'text') styles.set(node, inherited);
      if (node.children) for (const c of node.children) visit(c, inherited);
      return;
    }
    const decls = declaredStyles(node, stylesheet);
    const parentPx = inherited.fontSizePx;

    let fontSizePx = parentPx;
    if (UA_FONT_SCALE[node.tag]) fontSizePx = DEFAULT_FONT_PX * UA_FONT_SCALE[node.tag];
    if (node.tag === 'font' && node.attrs.size && FONT_SIZE_ATTR[node.attrs.size]) {
      fontSizePx = FONT_SIZE_ATTR[node.attrs.size];
    }
    if (decls['font-size']) {
      const px = lengthToPx(decls['font-size'], parentPx);
      if (px === null) warnings.push(`unparsed font-size "${decls['font-size']}" on <${node.tag}>`);
      else fontSizePx = px;
    }
    if (decls.font) {
      const m = decls.font.match(/(\d+(?:\.\d+)?)(px|pt|em|rem|%)/);
      if (m) fontSizePx = lengthToPx(m[0], parentPx);
    }

    let fontWeight = inherited.fontWeight;
    if (UA_BOLD.has(node.tag)) fontWeight = 700;
    const w = weightOf(decls['font-weight'], inherited.fontWeight);
    if (w !== null) fontWeight = w;

    let color = inherited.color;
    if (decls.color && decls.color.toLowerCase() !== 'inherit') {
      const c = parseColor(decls.color);
      if (c) color = composite(c, inherited.background);
      else warnings.push(`unparsed color "${decls.color}" on <${node.tag}>`);
    }
    if (node.tag === 'font' && node.attrs.color && !decls.color) {
      const c = parseColor(node.attrs.color);
      if (c) color = composite(c, inherited.background);
    }

    let background = inherited.background;
    const ownBg = backgroundColorOf(decls);
    if (ownBg) background = composite(ownBg, inherited.background);

    let textAlign = inherited.textAlign;
    if (UA_CENTER.has(node.tag)) textAlign = 'center';
    if (decls['text-align']) textAlign = decls['text-align'].toLowerCase();

    let lineHeight = inherited.lineHeight;
    if (decls['line-height']) {
      const raw = decls['line-height'].trim().toLowerCase();
      if (raw === 'normal') lineHeight = 1.2;
      else if (/^[\d.]+$/.test(raw)) lineHeight = parseFloat(raw);
      else {
        const px = lengthToPx(raw, fontSizePx);
        if (px !== null) lineHeight = px / fontSizePx;
        else warnings.push(`unparsed line-height "${raw}" on <${node.tag}>`);
      }
    }

    const spacingEm = (prop, fallback) => {
      if (!decls[prop]) return fallback;
      const raw = decls[prop].trim().toLowerCase();
      if (raw === 'normal') return 0;
      const px = lengthToPx(raw, fontSizePx);
      return px === null ? fallback : px / fontSizePx;
    };
    const letterSpacingEm = spacingEm('letter-spacing', inherited.letterSpacingEm);
    const wordSpacingEm = spacingEm('word-spacing', inherited.wordSpacingEm);

    const fontFamily = decls['font-family'] || inherited.fontFamily;

    const own = {
      color, background, fontSizePx, fontWeight, textAlign, lineHeight,
      letterSpacingEm, wordSpacingEm, fontFamily,
      declared: decls,
      hidden: /display\s*:\s*none/i.test(node.attrs.style || '') || decls.display === 'none'
        || (decls.visibility || '').toLowerCase() === 'hidden' || node.tag === 'script' || node.tag === 'style'
        || inherited.hidden === true
    };
    styles.set(node, own);

    // Inheritance: text properties pass down, and so does the effective backdrop, which is
    // what a descendant's text is actually painted on when it declares no background of
    // its own. `declared` deliberately does not pass down.
    const next = {
      color: own.color,
      background: own.background,
      fontSizePx: own.fontSizePx,
      fontWeight: own.fontWeight,
      textAlign: own.textAlign,
      lineHeight: own.lineHeight,
      letterSpacingEm: own.letterSpacingEm,
      wordSpacingEm: own.wordSpacingEm,
      fontFamily: own.fontFamily,
      hidden: own.hidden
    };
    for (const c of node.children) visit(c, next);
  };

  visit(root, inheritedDefault);
  return { styles, warnings, pageBackground };
}

export function styleOf(styles, node) {
  return styles.get(node) || null;
}
