// Shared measurement rules for the browser extension.
//
// A Manifest V3 content script cannot be an ES module, so it cannot import src/color.js and
// src/alt.js the way the CLI does. This file restates those rules as a plain script that
// attaches one object to globalThis.
//
// Restating rules in a second place is how two copies drift apart, and a drifted copy in an
// accessibility tool means the extension and the CLI disagree about whether a page is
// readable. test/extension.test.js imports both this file and the src modules and asserts
// they agree on several thousand generated cases, so drift fails the suite rather than
// shipping quietly.

(function attach(global) {
  // WCAG 2.1 relative luminance. The 0.03928 branch is the sRGB transfer function's linear
  // segment near black. Dropping it and using a plain gamma curve shifts ratios by enough to
  // move a colour across the 4.5:1 line, which is the only place the number matters.
  function channelToLinear(c8) {
    const c = c8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(rgb) {
    return 0.2126 * channelToLinear(rgb.r)
      + 0.7152 * channelToLinear(rgb.g)
      + 0.0722 * channelToLinear(rgb.b);
  }

  // (lighter + 0.05) / (darker + 0.05). The 0.05 models ambient screen flare and is what keeps
  // black on white at 21:1 rather than infinity.
  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  const PX_PER_PT = 96 / 72;
  const LARGE_TEXT_PX = 18 * PX_PER_PT;
  const LARGE_TEXT_BOLD_PX = 14 * PX_PER_PT;

  function isLargeText(fontSizePx, fontWeight) {
    const weight = Number(fontWeight) || 400;
    if (fontSizePx >= LARGE_TEXT_PX) return true;
    return weight >= 700 && fontSizePx >= LARGE_TEXT_BOLD_PX;
  }

  function requiredRatio(fontSizePx, fontWeight) {
    return isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;
  }

  // Parse the colour strings getComputedStyle actually returns, which are rgb() and rgba().
  // Hex and named colours are accepted too so the same function can read author markup.
  const NAMED = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
    gray: '#808080', grey: '#808080', silver: '#c0c0c0', transparent: 'rgba(0,0,0,0)'
  };

  function parseColor(input) {
    if (input == null) return null;
    let s = String(input).trim().toLowerCase();
    if (s === '') return null;
    if (Object.prototype.hasOwnProperty.call(NAMED, s)) s = NAMED[s];
    if (s[0] === '#') {
      const hex = s.slice(1);
      const grab = (h) => parseInt(h.length === 1 ? h + h : h, 16);
      if (/^[0-9a-f]{3}$/.test(hex)) return { r: grab(hex[0]), g: grab(hex[1]), b: grab(hex[2]), a: 1 };
      if (/^[0-9a-f]{6}$/.test(hex)) {
        return { r: grab(hex.slice(0, 2)), g: grab(hex.slice(2, 4)), b: grab(hex.slice(4, 6)), a: 1 };
      }
      if (/^[0-9a-f]{8}$/.test(hex)) {
        return {
          r: grab(hex.slice(0, 2)), g: grab(hex.slice(2, 4)), b: grab(hex.slice(4, 6)),
          a: grab(hex.slice(6, 8)) / 255
        };
      }
      return null;
    }
    const m = s.match(/^rgba?\s*\(([^)]*)\)$/);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter((p) => p !== '');
    if (parts.length < 3) return null;
    const chan = (t) => {
      const v = parseFloat(t);
      if (!Number.isFinite(v)) return null;
      return Math.max(0, Math.min(255, Math.round(/%$/.test(t) ? (v / 100) * 255 : v)));
    };
    const r = chan(parts[0]);
    const g = chan(parts[1]);
    const b = chan(parts[2]);
    if (r === null || g === null || b === null) return null;
    let a = 1;
    if (parts.length >= 4) {
      const raw = parseFloat(parts[3]);
      if (!Number.isFinite(raw)) return null;
      a = Math.max(0, Math.min(1, /%$/.test(parts[3]) ? raw / 100 : raw));
    }
    return { r, g, b, a };
  }

  // Source-over compositing of a translucent colour onto an opaque backdrop.
  function composite(over, under) {
    const a = over.a == null ? 1 : over.a;
    if (a >= 1) return { r: over.r, g: over.g, b: over.b, a: 1 };
    return {
      r: over.r * a + under.r * (1 - a),
      g: over.g * a + under.g * (1 - a),
      b: over.b * a + under.b * (1 - a),
      a: 1
    };
  }

  function toHex(rgb) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
  }

  // Alt text classification. An empty alt is CORRECT for a decorative image and WRONG for an
  // informative one, so the two cases are separated rather than collapsed into "alt missing".
  const SPACER_NAMES = /(^|[/_-])(spacer|pixel|blank|clear|shim|dot|transparent)([._-]|$)/i;
  const PLACEHOLDER_ALT = /^(image|images?\d*|photo|picture|graphic|icon|logo|img|untitled|photograph|banner|spacer|\s*)$/i;
  const FILENAME_ALT = /\.(jpe?g|png|gif|webp|svg|bmp|tiff?)\s*$/i;

  function intAttr(v) {
    if (v == null) return null;
    const n = parseInt(String(v).replace(/px$/i, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  function looksLikeSpacer(img) {
    const w = intAttr(img.width);
    const h = intAttr(img.height);
    if (w !== null && h !== null && w <= 3 && h <= 3) return 'dimensions prove it carries no content';
    if (SPACER_NAMES.test(String(img.src || '').split('?')[0])) return 'filename matches a known spacer pattern';
    return null;
  }

  function classifyImage(img) {
    const src = img.src || '';
    const role = String(img.role || '').toLowerCase();
    const hasAlt = Boolean(img.hasAlt);
    const alt = hasAlt ? String(img.alt) : null;
    if (role === 'presentation' || role === 'none' || img.ariaHidden || (hasAlt && alt.trim() === '')) {
      return { status: 'declared-decorative', reason: 'author marked it decorative' };
    }
    if (hasAlt && alt.trim() !== '') {
      const trimmed = alt.trim();
      if (PLACEHOLDER_ALT.test(trimmed) || FILENAME_ALT.test(trimmed) || trimmed === src.split('/').pop()) {
        return { status: 'needs-human', reason: `alt text "${trimmed}" describes the file, not the content` };
      }
      if (trimmed.length < 3) {
        return { status: 'needs-human', reason: `alt text "${trimmed}" is too short to be a description` };
      }
      return { status: 'described', reason: 'alt text present' };
    }
    const spacer = looksLikeSpacer(img);
    if (spacer) return { status: 'auto-decorative', reason: spacer };
    return {
      status: 'needs-human',
      reason: 'no alt attribute, and this tool cannot see the image, so a human has to write it'
    };
  }

  global.LegibleCore = {
    channelToLinear,
    relativeLuminance,
    contrastRatio,
    isLargeText,
    requiredRatio,
    parseColor,
    composite,
    toHex,
    classifyImage,
    PX_PER_PT,
    LARGE_TEXT_PX,
    LARGE_TEXT_BOLD_PX,
    SPACER_NAMES,
    PLACEHOLDER_ALT,
    FILENAME_ALT
  };
}(typeof globalThis === 'undefined' ? this : globalThis));
