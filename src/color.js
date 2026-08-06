// CSS colour parsing and WCAG 2.1 contrast maths.
//
// Every number this module produces is a claim that gets checked twice: once by the unit
// tests against hand-computed values, and once by checks/independent_contrast.py, which
// recomputes the same ratios in Python from the raw colour strings and shares no code with
// this file.

const NAMED = {
  black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080', white: '#ffffff',
  maroon: '#800000', red: '#ff0000', purple: '#800080', fuchsia: '#ff00ff', green: '#008000',
  lime: '#00ff00', olive: '#808000', yellow: '#ffff00', navy: '#000080', blue: '#0000ff',
  teal: '#008080', aqua: '#00ffff', orange: '#ffa500', lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969',
  dimgrey: '#696969', gainsboro: '#dcdcdc', whitesmoke: '#f5f5f5', ivory: '#fffff0',
  beige: '#f5f5dc', linen: '#faf0e6', cornsilk: '#fff8dc', lightyellow: '#ffffe0',
  lightblue: '#add8e6', steelblue: '#4682b4', midnightblue: '#191970', darkblue: '#00008b',
  darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', slategray: '#708090',
  slategrey: '#708090', lightsteelblue: '#b0c4de', aliceblue: '#f0f8ff', seashell: '#fff5ee'
};

const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

function clamp255(n) { return Math.max(0, Math.min(255, n)); }

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

// Returns {r,g,b} 0..255 and a 0..1, or null when the value is not a colour we understand.
// Unknown is null on purpose. A silent fallback to black would turn "could not read this
// colour" into "the colour is black", which is exactly the failure this project exists to
// stop reporting.
export function parseColor(input) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  if (s === '') return null;
  if (s === 'transparent') return { ...TRANSPARENT };
  if (Object.prototype.hasOwnProperty.call(NAMED, s)) s = NAMED[s];

  if (s[0] === '#') {
    const hex = s.slice(1);
    const expand = (h) => parseInt(h.length === 1 ? h + h : h, 16);
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return { r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]), a: 1 };
    }
    if (/^[0-9a-f]{4}$/.test(hex)) {
      return { r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]), a: expand(hex[3]) / 255 };
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return { r: expand(hex.slice(0, 2)), g: expand(hex.slice(2, 4)), b: expand(hex.slice(4, 6)), a: 1 };
    }
    if (/^[0-9a-f]{8}$/.test(hex)) {
      return {
        r: expand(hex.slice(0, 2)), g: expand(hex.slice(2, 4)), b: expand(hex.slice(4, 6)),
        a: expand(hex.slice(6, 8)) / 255
      };
    }
    return null;
  }

  const fn = s.match(/^(rgba?|hsla?)\s*\(([^)]*)\)$/);
  if (!fn) return null;
  const name = fn[1];
  const parts = fn[2].split(/[\s,/]+/).filter((p) => p !== '');
  const num = (t) => {
    if (/%$/.test(t)) return { pct: true, v: parseFloat(t) };
    return { pct: false, v: parseFloat(t) };
  };
  if (parts.length < 3) return null;
  const a = parts.length >= 4 ? (/%$/.test(parts[3]) ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
  if (!Number.isFinite(a)) return null;

  if (name === 'rgb' || name === 'rgba') {
    const ch = parts.slice(0, 3).map(num);
    if (ch.some((c) => !Number.isFinite(c.v))) return null;
    const conv = (c) => clamp255(Math.round(c.pct ? (c.v / 100) * 255 : c.v));
    return { r: conv(ch[0]), g: conv(ch[1]), b: conv(ch[2]), a: Math.max(0, Math.min(1, a)) };
  }

  // hsl / hsla
  const h = ((parseFloat(parts[0]) % 360) + 360) % 360 / 360;
  const sat = parseFloat(parts[1]) / 100;
  const light = parseFloat(parts[2]) / 100;
  if (![h, sat, light].every(Number.isFinite)) return null;
  let r, g, b;
  if (sat === 0) {
    r = g = b = light;
  } else {
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
    const p = 2 * light - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  return {
    r: clamp255(Math.round(r * 255)), g: clamp255(Math.round(g * 255)),
    b: clamp255(Math.round(b * 255)), a: Math.max(0, Math.min(1, a))
  };
}

export function toHex({ r, g, b }) {
  const h = (n) => clamp255(Math.round(n)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// WCAG 2.1 relative luminance, https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
export function channelToLinear(c8) {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(rgb) {
  return 0.2126 * channelToLinear(rgb.r) + 0.7152 * channelToLinear(rgb.g) + 0.0722 * channelToLinear(rgb.b);
}

// WCAG 2.1 contrast ratio, (L1 + 0.05) / (L2 + 0.05) with L1 the lighter of the two.
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

// Source-over compositing of a translucent colour onto an opaque backdrop.
export function composite(over, under) {
  const a = over.a == null ? 1 : over.a;
  if (a >= 1) return { r: over.r, g: over.g, b: over.b, a: 1 };
  return {
    r: over.r * a + under.r * (1 - a),
    g: over.g * a + under.g * (1 - a),
    b: over.b * a + under.b * (1 - a),
    a: 1
  };
}

// WCAG 1.4.3: 18pt (24px) or 14pt (18.66px) bold and larger is "large text" at 3:1.
export const LARGE_TEXT_PX = 24;
export const LARGE_TEXT_BOLD_PX = 18.66;

export function isLargeText(fontSizePx, fontWeight) {
  const weight = Number(fontWeight) || 400;
  if (fontSizePx >= LARGE_TEXT_PX) return true;
  return weight >= 700 && fontSizePx >= LARGE_TEXT_BOLD_PX;
}

export function requiredRatio(fontSizePx, fontWeight) {
  return isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;
}
