// A minimal CSS cascade, big enough to answer "what colour is this text actually painted in,
// on what background, at what size". Supports type, class, id, universal, descendant and
// child combinators, and comma-separated selector groups. At-rules are recorded and skipped
// rather than silently dropped, so a document whose colours live inside @media prints a
// warning instead of quietly measuring the wrong thing.

export const INHERITED = new Set(['color', 'font-size', 'font-weight', 'font-family',
  'text-align', 'line-height', 'letter-spacing', 'word-spacing', 'font-style', 'text-transform']);

export function parseDeclarations(text) {
  const out = {};
  for (const chunk of String(text).split(';')) {
    const idx = chunk.indexOf(':');
    if (idx === -1) continue;
    const prop = chunk.slice(0, idx).trim().toLowerCase();
    const value = chunk.slice(idx + 1).trim();
    if (prop === '' || value === '') continue;
    out[prop] = value.replace(/\s*!important$/i, '');
    if (/!important\s*$/i.test(value)) out[`${prop}!important`] = true;
  }
  return out;
}

function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+/g) || []).length + (sel.match(/\[[^\]]+\]/g) || []).length;
  const types = (sel.replace(/[#.][\w-]+/g, ' ').match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
  return ids * 100 + classes * 10 + types;
}

export function parseStylesheet(css) {
  const rules = [];
  const warnings = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < src.length) {
    const brace = src.indexOf('{', i);
    if (brace === -1) break;
    const prelude = src.slice(i, brace).trim();
    // find matching close brace, accounting for nested blocks in at-rules
    let depth = 1;
    let j = brace + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    const body = src.slice(brace + 1, j - 1);
    if (prelude.startsWith('@')) {
      warnings.push(`at-rule not evaluated: ${prelude.split('{')[0].trim()}`);
    } else if (prelude !== '') {
      const decls = parseDeclarations(body);
      for (const sel of prelude.split(',')) {
        const s = sel.trim();
        if (s === '') continue;
        rules.push({ selector: s, declarations: decls, specificity: specificity(s), order: rules.length });
      }
    }
    i = j;
  }
  return { rules, warnings };
}

function matchesSimple(el, simple) {
  if (simple === '*') return true;
  const m = simple.match(/^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)$/);
  if (!m) return false;
  if (m[1] && el.tag !== m[1].toLowerCase()) return false;
  const rest = m[2] || '';
  const classes = (el.attrs.class || '').split(/\s+/).filter(Boolean);
  for (const part of rest.match(/[#.][\w-]+/g) || []) {
    if (part[0] === '#') { if (el.attrs.id !== part.slice(1)) return false; } else if (!classes.includes(part.slice(1))) return false;
  }
  return true;
}

export function selectorMatches(el, selector) {
  const parts = selector.trim().split(/\s+/);
  // Walk the selector right to left against the element's ancestor chain.
  let idx = parts.length - 1;
  let node = el;
  if (!matchesSimple(node, parts[idx])) return false;
  idx -= 1;
  let child = false;
  while (idx >= 0) {
    const part = parts[idx];
    if (part === '>') { child = true; idx -= 1; continue; }
    let cursor = node.parent;
    let matched = false;
    while (cursor && cursor.type === 'element') {
      if (matchesSimple(cursor, part)) { matched = true; node = cursor; break; }
      if (child) return false;
      cursor = cursor.parent;
    }
    if (!matched) return false;
    child = false;
    idx -= 1;
  }
  return true;
}

// Declarations that apply to one element, cascade order resolved.
export function declaredStyles(el, stylesheet) {
  const winners = {};
  const strength = {};
  const apply = (decls, spec, order, inline) => {
    for (const [prop, value] of Object.entries(decls)) {
      if (prop.endsWith('!important')) continue;
      const important = decls[`${prop}!important`] === true;
      const rank = (important ? 1e9 : 0) + (inline ? 1e6 : 0) + spec * 1000 + order;
      if (strength[prop] === undefined || rank >= strength[prop]) {
        strength[prop] = rank;
        winners[prop] = value;
      }
    }
  };
  for (const rule of stylesheet.rules) {
    if (selectorMatches(el, rule.selector)) apply(rule.declarations, rule.specificity, rule.order, false);
  }
  if (el.attrs && el.attrs.style) apply(parseDeclarations(el.attrs.style), 0, 0, true);

  // Presentational attributes that old documents still use.
  if (el.attrs) {
    if (el.attrs.bgcolor && winners['background-color'] === undefined) winners['background-color'] = el.attrs.bgcolor;
    if (el.attrs.color && winners.color === undefined) winners.color = el.attrs.color;
    if (el.attrs.align && winners['text-align'] === undefined) winners['text-align'] = el.attrs.align;
  }
  return winners;
}
