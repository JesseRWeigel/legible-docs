import { isVoid } from './parse.js';

const RAW_TEXT = new Set(['script', 'style']);

function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// `>` is escaped as well, which HTML does not require inside a quoted attribute value. It is
// required here because parse.js finds a tag's end with the next `>` and does not track quote
// state, so an unescaped `>` in an attribute would end the tag early. The remediated document
// gets re-parsed and re-audited by this same parser, and without this the second audit would
// measure a different tree than the one that was written.
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function serialize(node) {
  if (node.type === 'root') return node.children.map(serialize).join('');
  if (node.type === 'text') {
    if (node.parent && node.parent.type === 'element' && RAW_TEXT.has(node.parent.tag)) return node.value;
    return escapeText(node.value);
  }
  if (node.type === 'comment') return `<!--${node.value}-->`;
  if (node.type === 'doctype') return `<!${node.value}>`;
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => (v === '' ? ` ${k}=""` : ` ${k}="${escapeAttr(String(v))}"`))
    .join('');
  if (isVoid(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(serialize).join('')}</${node.tag}>`;
}

export function element(tag, attrs = {}, children = []) {
  const el = { type: 'element', tag, attrs, children: [], parent: null };
  for (const c of children) appendChild(el, c);
  return el;
}

export function textNode(value) {
  return { type: 'text', value, raw: value, parent: null };
}

export function appendChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}
