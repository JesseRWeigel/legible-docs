// Rewrite a document so a dyslexic or low vision reader can get through it, and record every
// change as a measurable claim.
//
// Two rules shape the whole file. Nothing in the original text is removed or reworded, so a
// legal notice stays a legal notice. Nothing is asserted that was not measured: colours come
// out of repair.js with a before and after ratio attached, reading order comes out of a
// ground truth comparison, and images with no alt text are flagged for a person rather than
// described by a machine that cannot see them.

import { parseHTML, walk, byTag, findAll, removeNode, textContent } from './html/parse.js';
import { serialize, element, textNode, appendChild } from './html/serialize.js';
import { auditDocument, TEXT_SPACING, MIN_BODY_PX } from './audit.js';
import { repairPair, shadeBand } from './repair.js';
import { parseColor, toHex, contrastRatio } from './color.js';
import { isLayoutTable, columnMajorCells, ownText } from './readingorder.js';
import { auditImages } from './alt.js';

export const FACES = {
  atkinson: "'Atkinson Hyperlegible', 'Atkinson Hyperlegible Next', 'Verdana', 'DejaVu Sans', sans-serif",
  opendyslexic: "'OpenDyslexic', 'OpenDyslexic3', 'Comic Sans MS', 'Verdana', sans-serif"
};

// Every text colour is pushed to 4.5:1 including large text, which WCAG AA only asks to reach
// 3:1. The stricter target is deliberate for a low vision audience and is stated in the
// report so the number is not mistaken for the AA threshold.
export const REPAIR_TARGET = 4.5;

const STRIP_ATTRS = ['bgcolor', 'color', 'align', 'valign', 'background', 'face', 'size',
  'cellpadding', 'cellspacing', 'border', 'width', 'height', 'hspace', 'vspace', 'nowrap'];

export function stylesheetFor(face, options = {}) {
  const family = FACES[face] || FACES.atkinson;
  const bodyPx = Math.max(MIN_BODY_PX, options.bodyPx || 19);
  return `
:root {
  --lgb-page: ${options.pageHex || '#ffffff'};
  --lgb-band: ${options.bandHex || '#eef1f5'};
  --lgb-ink: ${options.inkHex || '#1a1a1a'};
}
html {
  background: var(--lgb-page);
  line-height: ${TEXT_SPACING.lineHeight};
  letter-spacing: ${TEXT_SPACING.letterSpacingEm}em;
  word-spacing: ${TEXT_SPACING.wordSpacingEm}em;
  color: var(--lgb-ink);
}
body {
  font-family: ${family};
  font-size: ${bodyPx}px;
  line-height: ${TEXT_SPACING.lineHeight};
  letter-spacing: ${TEXT_SPACING.letterSpacingEm}em;
  word-spacing: ${TEXT_SPACING.wordSpacingEm}em;
  text-align: left;
  color: var(--lgb-ink);
  background: var(--lgb-page);
  margin: 0;
  padding: 1.5rem;
  hyphens: none;
}
main, .lgb-doc { max-width: 66ch; margin: 0 auto; }
p, li, dd, dt, td, th, blockquote, figcaption, a, span, label, caption {
  text-align: left;
  line-height: ${TEXT_SPACING.lineHeight};
  letter-spacing: ${TEXT_SPACING.letterSpacingEm}em;
  word-spacing: ${TEXT_SPACING.wordSpacingEm}em;
}
p { margin: 0 0 ${TEXT_SPACING.paragraphSpacingEm}em 0; padding: 0.35em 0.6em; }
p.lgb-shade { background: var(--lgb-band); }
h1, h2, h3, h4, h5, h6 {
  font-family: ${family};
  line-height: 1.3;
  letter-spacing: ${TEXT_SPACING.letterSpacingEm}em;
  text-align: left;
  margin: 1.6em 0 0.6em 0;
}
h1 { font-size: 2em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
ul, ol { padding-left: 1.6em; }
li { margin-bottom: 0.8em; }
table { border-collapse: collapse; margin: 1.5em 0; }
th, td { border: 1px solid #767676; padding: 0.5em 0.7em; text-align: left; }
.lgb-column { margin-bottom: 2em; }
.lgb-alt-flag {
  border-left: 6px solid #8a1c1c;
  background: #fdecec;
  color: #5c0d0d;
  padding: 0.6em 0.9em;
  font-weight: 700;
}
.lgb-summary {
  border: 3px solid #1a3d6d;
  background: #eef3fb;
  color: #14243d;
  padding: 1em 1.2em;
  margin: 0 auto 2em auto;
  max-width: 66ch;
}
.lgb-summary h2 { margin-top: 0; font-size: 1.2em; }
.lgb-skip {
  position: absolute; left: -9999px; top: 0;
  background: #ffffff; color: #1a1a1a; padding: 0.6em 1em; border: 3px solid #1a3d6d;
}
.lgb-skip:focus { left: 0; }
img { max-width: 100%; height: auto; }
`.trim();
}

function stripPresentation(root) {
  const removedStyleBlocks = byTag(root, 'style').length;
  for (const s of byTag(root, 'style')) removeNode(s);
  for (const l of findAll(root, (n) => n.type === 'element' && n.tag === 'link'
    && (n.attrs.rel || '').toLowerCase().includes('stylesheet'))) removeNode(l);
  walk(root, (n) => {
    if (n.type !== 'element') return;
    delete n.attrs.style;
    for (const attr of STRIP_ATTRS) {
      if (n.tag === 'img' && (attr === 'width' || attr === 'height')) continue;
      delete n.attrs[attr];
    }
  });
  return removedStyleBlocks;
}

function convertLegacyTags(root) {
  let converted = 0;
  walk(root, (n) => {
    if (n.type !== 'element') return;
    if (n.tag === 'font') { n.tag = 'span'; converted += 1; }
    if (n.tag === 'center') { n.tag = 'div'; converted += 1; }
    if (n.tag === 'marquee') { n.tag = 'div'; converted += 1; }
    if (n.tag === 'blink') { n.tag = 'span'; converted += 1; }
  });
  return converted;
}

function unwrapLayoutTables(root) {
  const actions = [];
  let tables = byTag(root, 'table').filter(isLayoutTable);
  // Innermost first, so a layout table nested inside another is handled before its parent
  // disappears from the tree.
  tables = tables.sort((a, b) => {
    const depth = (n) => { let d = 0; let p = n.parent; while (p) { d += 1; p = p.parent; } return d; };
    return depth(b) - depth(a);
  });
  for (const table of tables) {
    const cells = columnMajorCells(table);
    if (cells.length === 0) continue;
    const container = element('div', { class: 'lgb-unwrapped' });
    for (const cell of cells) {
      const section = element('div', { class: 'lgb-column' });
      for (const child of cell.children.slice()) {
        appendChild(section, child);
      }
      appendChild(container, section);
    }
    const parent = table.parent;
    const idx = parent.children.indexOf(table);
    container.parent = parent;
    parent.children.splice(idx, 1, container);
    actions.push({ cells: cells.length });
  }
  return actions;
}

const PROMOTABLE_BLOCKS = new Set(['p', 'div', 'span', 'section', 'header', 'b', 'strong', 'font']);

function promoteVisualHeadings(root, audit, level = 2) {
  const promoted = [];
  const skipped = [];
  // Match by the run's text, because element paths change once layout tables are unwrapped.
  const wanted = new Set(audit.details.visualHeadings.map((v) => v.sample.trim()));
  if (wanted.size === 0) return { promoted, skipped };
  walk(root, (n) => {
    if (n.type !== 'element') return;
    if (/^h[1-6]$/.test(n.tag)) return;
    const direct = n.children.filter((c) => c.type === 'text').map((c) => c.value).join('')
      .replace(/\s+/g, ' ').trim();
    if (direct === '') return;
    const key = direct.slice(0, 60).trim();
    if (!wanted.has(key)) return;

    // Promote the block that holds the line, not the <b> inside it, so the output is a real
    // heading element rather than an h2 buried in a paragraph.
    let target = n;
    while (target && !['p', 'div', 'section', 'header', 'li', 'td', 'th'].includes(target.tag)) {
      target = target.parent && target.parent.type === 'element' ? target.parent : null;
    }
    if (!target || ['li', 'td', 'th'].includes(target.tag)) target = n;
    const targetText = ownText(target).replace(/\s+/g, ' ').trim();
    if (targetText !== direct || !PROMOTABLE_BLOCKS.has(target.tag)) {
      skipped.push({ text: direct.slice(0, 60), reason: 'the line shares its block with other text, so promoting it would change the structure' });
      return;
    }
    wanted.delete(key);
    target.tag = `h${level}`;
    delete target.attrs.class;
    promoted.push(direct.slice(0, 80));
  });
  return { promoted, skipped };
}

function ensureLandmarks(root, langCode) {
  const actions = [];
  const htmlEl = byTag(root, 'html')[0];
  if (htmlEl && !htmlEl.attrs.lang) { htmlEl.attrs.lang = langCode; actions.push(`set html lang="${langCode}"`); }
  const body = byTag(root, 'body')[0];
  if (!body) return actions;
  if (byTag(root, 'main').length === 0) {
    const main = element('main', { id: 'lgb-main' });
    for (const child of body.children.slice()) appendChild(main, child);
    body.children = [];
    appendChild(body, main);
    actions.push('wrapped body content in a <main> landmark');
  }
  const main = byTag(root, 'main')[0];
  if (main && !main.attrs.id) main.attrs.id = 'lgb-main';
  const skip = element('a', { href: `#${main ? main.attrs.id : 'lgb-main'}`, class: 'lgb-skip' }, [textNode('Skip to the document')]);
  body.children.unshift(skip);
  skip.parent = body;
  actions.push('added a skip link');
  return actions;
}

function flagImages(root) {
  const audit = auditImages(root);
  const flags = [];
  for (const finding of audit.findings) {
    const img = finding.node;
    img.attrs['data-lgb-alt-status'] = finding.status;
    if (finding.status === 'auto-decorative') {
      img.attrs.alt = '';
      img.attrs.role = 'presentation';
      flags.push({ src: finding.src, status: finding.status, action: 'marked decorative from evidence: ' + finding.reason });
      continue;
    }
    if (finding.status !== 'needs-human') {
      flags.push({ src: finding.src, status: finding.status, action: 'left as authored' });
      continue;
    }
    // No alt is invented. The image keeps its missing or useless alt so every other checker
    // still reports it, and a visible note tells the reader a description is owed.
    const note = element('p', { class: 'lgb-alt-flag', role: 'note' }, [
      textNode(`Image needs a description written by a person. Source: ${finding.src || '(no src)'}. Reason: ${finding.reason}.`)
    ]);
    const parent = img.parent;
    if (parent) {
      const idx = parent.children.indexOf(img);
      note.parent = parent;
      parent.children.splice(idx + 1, 0, note);
    }
    flags.push({ src: finding.src, status: finding.status, action: 'flagged for a human, no alt text invented', reason: finding.reason });
  }
  return { flags, counts: { total: audit.total, needsHuman: audit.needsHuman, described: audit.described, declaredDecorative: audit.declaredDecorative, autoDecorative: audit.autoDecorative } };
}

function shadeParagraphs(root) {
  const paragraphs = byTag(root, 'p').filter((p) => ownText(p).trim() !== '' && !(p.attrs.class || '').includes('lgb-'));
  let shaded = 0;
  paragraphs.forEach((p, i) => {
    if (i % 2 === 1) {
      p.attrs.class = `${p.attrs.class ? `${p.attrs.class} ` : ''}lgb-shade`;
      shaded += 1;
    }
  });
  return { paragraphs: paragraphs.length, shaded };
}

/**
 * @param {string} html source document
 * @param {object} options {face, lang, summary: {title, paragraphs}, expectedOrder, shade}
 */
export function remediateHTML(html, options = {}) {
  const face = options.face || 'atkinson';
  const langCode = options.lang || 'en';
  const before = auditDocument(html, { expectedOrder: options.expectedOrder });

  // Colour decisions are taken against the ORIGINAL cascade, then written as inline styles on
  // the output, because the output drops the author stylesheet that caused the problem.
  const pageHex = '#ffffff';
  const page = parseColor(pageHex);
  const ink = parseColor('#1a1a1a');
  const band = shadeBand(page, ink, REPAIR_TARGET);

  // The tree that gets mutated is the one the "before" audit measured, so every original
  // colour is available by node identity with no index matching between two parses.
  const root = before.root;
  const originalColors = new Map();
  walk(root, (n) => {
    if (n.type !== 'element') return;
    const st = before.styles.get(n);
    if (st) {
      originalColors.set(n, {
        color: st.color, background: st.background, fontSizePx: st.fontSizePx,
        fontWeight: st.fontWeight, declared: st.declared, hidden: st.hidden
      });
    }
  });

  const actions = [];
  const removedStyleBlocks = stripPresentation(root);
  if (removedStyleBlocks) actions.push(`removed ${removedStyleBlocks} author stylesheet block(s) that set the failing colours`);
  const converted = convertLegacyTags(root);
  if (converted) actions.push(`converted ${converted} presentational tag(s) such as <font> and <center>`);
  const unwrapped = unwrapLayoutTables(root);
  if (unwrapped.length) actions.push(`unwrapped ${unwrapped.length} layout table(s) into column order sections`);
  const { promoted, skipped: headingsNotPromoted } = promoteVisualHeadings(root, before);
  if (promoted.length) actions.push(`promoted ${promoted.length} visually styled line(s) to real headings`);
  if (headingsNotPromoted.length) actions.push(`left ${headingsNotPromoted.length} styled line(s) as text, promoting them would have changed the structure`);
  const landmarks = ensureLandmarks(root, langCode);
  actions.push(...landmarks);
  const imageWork = flagImages(root);
  const shading = options.shade === false ? { paragraphs: 0, shaded: 0 } : shadeParagraphs(root);
  if (shading.shaded) actions.push(`shaded ${shading.shaded} of ${shading.paragraphs} paragraphs in alternating bands at ${band.bandContrast.toFixed(2)}:1 against the page`);

  // Repair colours element by element.
  const colorRepairs = [];
  walk(root, (n) => {
    if (n.type !== 'element') return;
    const orig = originalColors.get(n);
    if (!orig || orig.hidden) return;
    const text = ownText(n).replace(/\s+/g, ' ').trim();
    if (text === '') return;
    // The output background is known exactly: the page, or a shading band on alternate
    // paragraphs. Author backgrounds are gone with the author stylesheet, so there is no
    // guesswork about what the repaired colour will sit on.
    const shadedAncestor = n === root ? false : [n, ...(function ups(x) { const o = []; let p = x.parent; while (p) { o.push(p); p = p.parent; } return o; }(n))]
      .some((a) => a.attrs && (a.attrs.class || '').includes('lgb-shade'));
    const bg = shadedAncestor ? band.band : page;
    const repaired = repairPair(orig.color, bg, REPAIR_TARGET);
    const beforeRatio = contrastRatio(orig.color, orig.background);
    const styleBits = [`color: ${toHex(repaired.fg)}`];
    n.attrs.style = styleBits.join('; ');
    colorRepairs.push({
      sample: text.slice(0, 50),
      tag: n.tag,
      foregroundBefore: toHex(orig.color),
      backgroundBefore: toHex(orig.background),
      ratioBefore: Number(beforeRatio.toFixed(4)),
      foregroundAfter: toHex(repaired.fg),
      backgroundAfter: toHex(bg),
      ratioAfter: Number(contrastRatio(repaired.fg, bg).toFixed(4)),
      changed: toHex(repaired.fg) !== toHex(orig.color),
      direction: repaired.direction,
      met: contrastRatio(repaired.fg, bg) >= REPAIR_TARGET
    });
  });
  const movedColors = colorRepairs.filter((c) => c.changed).length;
  actions.push(`repaired ${movedColors} text colour(s) to at least ${REPAIR_TARGET}:1, left ${colorRepairs.length - movedColors} unchanged because they already passed`);

  // Head: title, charset, viewport, our stylesheet.
  let head = byTag(root, 'head')[0];
  if (!head) {
    const htmlEl = byTag(root, 'html')[0];
    head = element('head', {});
    if (htmlEl) { head.parent = htmlEl; htmlEl.children.unshift(head); }
  }
  if (head) {
    const existingTitle = byTag(root, 'title')[0];
    const titleText = existingTitle
      ? existingTitle.children.filter((c) => c.type === 'text').map((c) => c.value).join('').trim()
      : '';
    if (titleText === '') {
      // Taken verbatim from the document's own first heading. Nothing is invented: if there
      // is no heading to copy, the document goes out without a title and the audit keeps
      // reporting it as missing.
      const firstHeading = ['h1', 'h2', 'h3'].flatMap((t) => byTag(root, t))[0];
      const copied = firstHeading ? ownText(firstHeading).replace(/\s+/g, ' ').trim() : '';
      if (copied !== '') {
        if (existingTitle) removeNode(existingTitle);
        appendChild(head, element('title', {}, [textNode(copied.slice(0, 120))]));
        actions.push('added a document title copied verbatim from the first heading');
      } else {
        actions.push('no document title added, the document has no heading to copy one from');
      }
    }
    if (!findAll(head, (n) => n.type === 'element' && n.tag === 'meta' && n.attrs.charset).length) {
      appendChild(head, element('meta', { charset: 'utf-8' }));
    }
    appendChild(head, element('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }));
    const css = stylesheetFor(face, { pageHex, bandHex: band.hex, inkHex: toHex(ink) });
    const styleEl = element('style', {});
    appendChild(styleEl, textNode(css));
    appendChild(head, styleEl);
  }

  // Optional plain language summary, placed alongside and never replacing the original text.
  let summaryInserted = false;
  if (options.summary && options.summary.paragraphs && options.summary.paragraphs.length) {
    const body = byTag(root, 'body')[0];
    const main = byTag(root, 'main')[0];
    const aside = element('aside', { class: 'lgb-summary', 'aria-labelledby': 'lgb-summary-title' });
    appendChild(aside, element('h2', { id: 'lgb-summary-title' }, [textNode(options.summary.title || 'Plain language summary')]));
    appendChild(aside, element('p', { style: 'color: #14243d' }, [textNode(options.summary.disclaimer
      || 'Written by a language model from the text below. It can be wrong. The full original text follows and has not been changed.')]));
    for (const para of options.summary.paragraphs) {
      appendChild(aside, element('p', { style: 'color: #14243d' }, [textNode(para)]));
    }
    if (main && main.parent) {
      const parent = main.parent;
      const idx = parent.children.indexOf(main);
      aside.parent = parent;
      parent.children.splice(idx, 0, aside);
      summaryInserted = true;
    } else if (body) {
      aside.parent = body;
      body.children.unshift(aside);
      summaryInserted = true;
    }
    if (summaryInserted) actions.push('inserted a plain language summary alongside the original text');
  }

  const outHtml = `${serialize(root)}\n`;
  const after = auditDocument(outHtml, { expectedOrder: options.expectedOrder });

  return {
    html: outHtml,
    before,
    after,
    report: {
      actions,
      colorRepairs,
      repairTarget: REPAIR_TARGET,
      band: { hex: band.hex, bandContrast: Number(band.bandContrast.toFixed(4)), textContrast: Number(band.textContrast.toFixed(4)) },
      shading,
      headingsPromoted: promoted,
      headingsNotPromoted,
      layoutTablesUnwrapped: unwrapped.length,
      images: imageWork,
      summaryInserted,
      face,
      textSpacing: TEXT_SPACING
    }
  };
}

// The original wording has to survive remediation. This compares the visible text of the two
// documents word by word, ignoring only whitespace and anything this tool added, and is run
// as an assertion by the CLI rather than left as a promise in a README.
export function textPreserved(sourceHtml, remediatedHtml) {
  // Only the wrappers this tool ADDS text inside are removed before comparing. Classes such
  // as lgb-column and lgb-shade wrap the document's own words, and stripping those would make
  // the check pass by deleting the very text it is supposed to be watching.
  const ADDED = ['lgb-alt-flag', 'lgb-summary', 'lgb-skip'];
  const visible = (html) => {
    const root = parseHTML(html);
    for (const el of findAll(root, (n) => n.type === 'element'
      && ADDED.some((c) => (n.attrs.class || '').split(/\s+/).includes(c)))) removeNode(el);
    for (const el of byTag(root, 'style')) removeNode(el);
    // A space is inserted at every element boundary in both documents. Without it, unwrapping
    // a layout table concatenates the last word of one cell with the first word of the next,
    // and the check reports words missing that are still there.
    let out = '';
    const visit = (node) => {
      if (node.type === 'text') { out += node.value; return; }
      if (node.type === 'element' || node.type === 'root') {
        out += ' ';
        for (const c of node.children || []) visit(c);
        out += ' ';
      }
    };
    visit(root);
    return out.replace(/\s+/g, ' ').trim();
  };
  const a = visible(sourceHtml);
  const b = visible(remediatedHtml);
  const wordsA = a.split(' ').filter(Boolean);
  const wordsB = b.split(' ').filter(Boolean);
  const missing = [];
  const bagB = new Map();
  for (const w of wordsB) bagB.set(w, (bagB.get(w) || 0) + 1);
  for (const w of wordsA) {
    const n = bagB.get(w) || 0;
    if (n === 0) missing.push(w);
    else bagB.set(w, n - 1);
  }
  return { sourceWords: wordsA.length, outputWords: wordsB.length, missing, preserved: missing.length === 0 };
}
