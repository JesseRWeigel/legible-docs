// A small tolerant HTML parser. It handles the subset that real public notices, school
// letters, and benefit forms are written in: unclosed <p> and <li>, layout tables, inline
// style attributes, <style> blocks, uppercase tag names, unquoted attribute values.
// It is not a full HTML5 tree builder and does not pretend to be.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);

// start tag -> tags it implicitly closes if they are the open element
const IMPLICIT_CLOSE = {
  p: ['p'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['td', 'th', 'tr'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
  thead: ['td', 'th', 'tr'],
  tbody: ['td', 'th', 'tr'],
  tfoot: ['td', 'th', 'tr']
};
const BLOCK_CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl',
  'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);

export function isVoid(tag) { return VOID.has(tag); }

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—',
  ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“',
  rdquo: '”', copy: '©', reg: '®', deg: '°', middot: '·'
};

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
  });
}

function parseAttributes(src) {
  const attrs = {};
  const re = /([^\s=/>]+)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1].toLowerCase();
    if (name === '/') continue;
    let value = '';
    if (m[2] !== undefined) value = m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : (m[6] || ''));
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

export function parseHTML(html) {
  const root = { type: 'root', children: [], parent: null };
  let cur = root;
  let i = 0;

  const pushText = (raw) => {
    if (raw === '') return;
    cur.children.push({ type: 'text', value: decodeEntities(raw), raw, parent: cur });
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      const stop = end === -1 ? html.length : end + 3;
      cur.children.push({ type: 'comment', value: html.slice(lt + 4, end === -1 ? html.length : end), parent: cur });
      i = stop;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? html.length : end + 1;
      cur.children.push({ type: 'doctype', value: html.slice(lt + 2, end === -1 ? html.length : end), parent: cur });
      i = stop;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? html.length : end + 1;
      const tag = html.slice(lt + 2, end === -1 ? html.length : end).trim().toLowerCase();
      // Pop to the nearest matching ancestor. An end tag with no open counterpart is dropped.
      let node = cur;
      while (node && node.type === 'element' && node.tag !== tag) node = node.parent;
      if (node && node.type === 'element' && node.tag === tag) cur = node.parent;
      i = stop;
      continue;
    }

    const end = html.indexOf('>', lt);
    if (end === -1) { pushText(html.slice(lt)); break; }
    const inner = html.slice(lt + 1, end);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const sp = body.search(/\s/);
    const tag = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) { pushText(html.slice(lt, end + 1)); i = end + 1; continue; }
    const attrs = sp === -1 ? {} : parseAttributes(body.slice(sp));

    // Implicit closing has to repeat, not fire once. In `<tr><td>a<td>b<tr>` the second <tr>
    // has to close the open <td> AND the open <tr>. Popping a single level left the new row
    // nested inside the previous one, which turned a two row table into a three row tree and
    // scrambled the column order that the reading order measurement depends on.
    const closes = IMPLICIT_CLOSE[tag] || [];
    while (cur.type === 'element'
      && (closes.includes(cur.tag) || (cur.tag === 'p' && BLOCK_CLOSES_P.has(tag)))) {
      cur = cur.parent;
    }

    const el = { type: 'element', tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    i = end + 1;

    if (VOID.has(tag) || selfClosing) continue;
    if (RAW_TEXT.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = rest.match(closeRe);
      const textEnd = m ? m.index : rest.length;
      if (textEnd > 0) el.children.push({ type: 'text', value: rest.slice(0, textEnd), raw: rest.slice(0, textEnd), parent: el });
      i += textEnd + (m ? m[0].length : 0);
      continue;
    }
    cur = el;
  }
  return root;
}

export function walk(node, fn, depth = 0) {
  fn(node, depth);
  if (node.children) for (const c of node.children) walk(c, fn, depth + 1);
}

export function textContent(node) {
  let out = '';
  walk(node, (n) => { if (n.type === 'text' && !(n.parent && n.parent.type === 'element' && RAW_TEXT.has(n.parent.tag))) out += n.value; });
  return out;
}

export function findAll(node, pred) {
  const out = [];
  walk(node, (n) => { if (pred(n)) out.push(n); });
  return out;
}

export function findFirst(node, pred) {
  let found = null;
  walk(node, (n) => { if (!found && pred(n)) found = n; });
  return found;
}

export function byTag(node, tag) {
  return findAll(node, (n) => n.type === 'element' && n.tag === tag);
}

export function ancestors(node) {
  const out = [];
  let p = node.parent;
  while (p) { out.push(p); p = p.parent; }
  return out;
}

export function removeNode(node) {
  const p = node.parent;
  if (!p) return;
  const idx = p.children.indexOf(node);
  if (idx >= 0) p.children.splice(idx, 1);
}
