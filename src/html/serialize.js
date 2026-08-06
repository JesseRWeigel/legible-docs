import { isVoid } from './parse.js';

const RAW_TEXT = new Set(['script', 'style']);

function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
