import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, textContent, byTag, decodeEntities, findAll } from '../src/html/parse.js';
import { serialize, element, textNode, appendChild } from '../src/html/serialize.js';

test('unclosed paragraphs and list items nest as siblings, not as a chain', () => {
  const root = parseHTML('<body><p>one<p>two<ul><li>a<li>b</ul></body>');
  const ps = byTag(root, 'p');
  assert.equal(ps.length, 2);
  assert.equal(ps[0].parent.tag, 'body', 'the second <p> must not be a child of the first');
  assert.equal(ps[1].parent.tag, 'body');
  const lis = byTag(root, 'li');
  assert.equal(lis.length, 2);
  assert.equal(lis[1].parent.tag, 'ul');
});

test('uppercase tags and unquoted attributes are handled', () => {
  const root = parseHTML('<TABLE WIDTH=760 BORDER=0><TR><TD BGCOLOR="#eee">x</TD></TR></TABLE>');
  const td = byTag(root, 'td')[0];
  assert.equal(td.attrs.bgcolor, '#eee');
  assert.equal(byTag(root, 'table')[0].attrs.width, '760');
});

test('table rows and cells close each other implicitly', () => {
  const root = parseHTML('<table><tr><td>a<td>b<tr><td>c</table>');
  const rows = byTag(root, 'tr');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children.filter((c) => c.type === 'element').length, 2);
});

test('a stray end tag is dropped rather than unwinding the tree', () => {
  const root = parseHTML('<div><p>kept</p></span></div><p>also kept</p>');
  assert.equal(byTag(root, 'p').length, 2);
  assert.match(textContent(root), /kept/);
});

test('entities decode, including numeric and hex forms', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42; &nbsp;'), 'a & b <c> A B  ');
  // An entity this parser does not know is left alone rather than turned into a wrong glyph.
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

test('script and style contents never leak into the document text', () => {
  const root = parseHTML('<style>p{color:#fff}</style><script>var x = "hello"</script><p>visible</p>');
  const text = textContent(root).replace(/\s+/g, ' ').trim();
  assert.equal(text, 'visible');
  assert.doesNotMatch(text, /color|hello/);
});

test('raw text elements keep their contents verbatim', () => {
  const root = parseHTML('<style>a > b { content: "</p>" }</style>');
  const style = byTag(root, 'style')[0];
  assert.match(style.children[0].value, /a > b/);
});

test('void elements do not swallow the rest of the document', () => {
  const root = parseHTML('<p><img src="a.png"><br>after</p><p>next</p>');
  assert.equal(byTag(root, 'p').length, 2);
  assert.equal(byTag(root, 'img')[0].children.length, 0);
});

test('serialize round trips a parsed document', () => {
  const src = '<!DOCTYPE html><html lang="en"><head><title>T</title></head><body><p class="a">Hi &amp; bye</p><img src="x.png" alt=""></body></html>';
  const out = serialize(parseHTML(src));
  const reparsed = parseHTML(out);
  assert.equal(textContent(reparsed).trim(), 'THi & bye');
  assert.equal(byTag(reparsed, 'img')[0].attrs.alt, '');
  assert.match(out, /alt=""/, 'an empty alt must survive, it is meaningful markup');
});

test('serialize escapes text and attributes so output cannot be reinterpreted as markup', () => {
  const el = element('p', { title: 'a "quoted" & <angled> value' }, [textNode('<script>alert(1)</script>')]);
  const out = serialize(el);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&quot;quoted&quot;/);
  const back = parseHTML(out);
  assert.equal(textContent(back), '<script>alert(1)</script>');
  assert.equal(byTag(back, 'p')[0].attrs.title, 'a "quoted" & <angled> value');
});

test('appendChild keeps the parent pointer consistent', () => {
  const parent = element('div');
  const child = element('span');
  appendChild(parent, child);
  assert.equal(child.parent, parent);
  assert.equal(parent.children[0], child);
});

test('comments and doctypes survive without becoming text', () => {
  const root = parseHTML('<!DOCTYPE html><!-- a note --><p>x</p>');
  assert.equal(findAll(root, (n) => n.type === 'comment').length, 1);
  assert.equal(findAll(root, (n) => n.type === 'doctype').length, 1);
  assert.equal(textContent(root).trim(), 'x');
});
