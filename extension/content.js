// Content script. Measures the live page, then reflows it for a dyslexic or low vision reader.
//
// The CLI reimplements a small CSS cascade because it has no browser. Here there is one, so
// every colour and size comes from getComputedStyle and no cascade is guessed at. That makes
// the extension the more accurate of the two measurements on any page it can reach, and it is
// why the numbers it reports can differ slightly from `legible audit` on the same file.
//
// Nothing here removes or rewrites the document's words. The reflow changes presentation, and
// the plain language summary, when the CLI produces one, is added beside the text and never
// on top of it.

(function attach(global) {
  const C = global.LegibleCore;
  if (!C) throw new Error('legible-core.js must load before content.js');

  const TARGET = 4.5;
  const STYLE_ID = 'lgb-injected-style';
  const MARK = 'data-lgb-original-style';

  // Everything an element paints text on, resolved by walking ancestors and compositing every
  // translucent layer in order. Stopping at the first non-transparent background is wrong when
  // that background is itself semi-transparent, and semi-transparent panels over a dark hero
  // image are exactly where real pages fail contrast.
  function effectiveBackground(el) {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = C.parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1) break;
      }
      node = node.parentElement;
    }
    // The canvas under everything. If no opaque layer was found the browser paints white.
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) base = C.composite(layers[i], base);
    return base;
  }

  function isRendered(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    return el.getClientRects().length > 0 || el.tagName === 'BODY' || el.tagName === 'HTML';
  }

  // Text painted directly by this element, not by a descendant. Attributing a child span's
  // words to every ancestor as well would count one sentence several times, each at a
  // different colour, and inflate the failure count.
  function ownText(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.nodeValue;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD', 'META', 'LINK']);

  function auditContrast(doc) {
    const runs = [];
    for (const el of doc.querySelectorAll('*')) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (el.closest('.lgb-summary, .lgb-alt-flag, .lgb-skip')) continue;
      const text = ownText(el);
      if (text === '') continue;
      if (!isRendered(el)) continue;
      const cs = getComputedStyle(el);
      const fg = C.parseColor(cs.color);
      if (!fg) continue;
      const bg = effectiveBackground(el);
      const painted = C.composite(fg, bg);
      const fontSizePx = parseFloat(cs.fontSize) || 16;
      const fontWeight = Number(cs.fontWeight) || 400;
      const required = C.requiredRatio(fontSizePx, fontWeight);
      const ratio = C.contrastRatio(painted, bg);
      runs.push({
        tag: el.tagName.toLowerCase(),
        sample: text.slice(0, 60),
        foreground: C.toHex(painted),
        background: C.toHex(bg),
        fontSizePx: Number(fontSizePx.toFixed(2)),
        fontWeight,
        large: C.isLargeText(fontSizePx, fontWeight),
        required,
        ratio: Number(ratio.toFixed(4)),
        pass: ratio >= required,
        textAlign: cs.textAlign,
        lineHeight: cs.lineHeight === 'normal' ? 1.2 : Number((parseFloat(cs.lineHeight) / fontSizePx).toFixed(3))
      });
    }
    return runs;
  }

  function auditImages(doc) {
    const out = [];
    for (const img of doc.querySelectorAll('img, input[type=image]')) {
      const verdict = C.classifyImage({
        src: img.getAttribute('src') || '',
        alt: img.getAttribute('alt'),
        hasAlt: img.hasAttribute('alt'),
        role: img.getAttribute('role') || '',
        ariaHidden: (img.getAttribute('aria-hidden') || '').toLowerCase() === 'true',
        width: img.getAttribute('width'),
        height: img.getAttribute('height')
      });
      out.push({ src: img.getAttribute('src') || '', status: verdict.status, reason: verdict.reason, el: img });
    }
    return out;
  }

  // Reading order, measured the way the DOM will be linearised for a screen reader and
  // compared against where the boxes actually sit on screen. A layout table that puts two
  // stories side by side reads correctly with the eyes and interleaves in the DOM, and that
  // disagreement is the number this returns.
  function auditReadingOrder(doc) {
    const blocks = [];
    const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,caption,dt,dd,pre';
    let domIndex = 0;
    for (const el of doc.querySelectorAll(BLOCK)) {
      if (ownText(el) === '') continue;
      if (!isRendered(el)) continue;
      const rect = el.getBoundingClientRect();
      blocks.push({
        domIndex: domIndex++,
        top: rect.top + global.scrollY,
        left: rect.left + global.scrollX,
        text: ownText(el).slice(0, 50)
      });
    }
    // Visual order: whole columns before rows. Two blocks are in the same column when their
    // horizontal spans overlap, so a column break is a real horizontal separation.
    const columns = [];
    for (const b of blocks.slice().sort((a, c) => a.left - c.left)) {
      const col = columns.find((x) => Math.abs(x.left - b.left) < 40);
      if (col) col.items.push(b);
      else columns.push({ left: b.left, items: [b] });
    }
    const visual = [];
    for (const col of columns.sort((a, c) => a.left - c.left)) {
      visual.push(...col.items.sort((a, c) => a.top - c.top));
    }
    let inversions = 0;
    let pairs = 0;
    for (let i = 0; i < visual.length; i += 1) {
      for (let j = i + 1; j < visual.length; j += 1) {
        pairs += 1;
        if (visual[i].domIndex > visual[j].domIndex) inversions += 1;
      }
    }
    return {
      blocks: blocks.length,
      columns: columns.length,
      inversions,
      pairs,
      tauDistance: pairs === 0 ? 0 : Number((inversions / pairs).toFixed(4))
    };
  }

  function audit(doc) {
    const target = doc || global.document;
    const runs = auditContrast(target);
    const images = auditImages(target);
    const ratios = runs.map((r) => r.ratio);
    const count = (s) => images.filter((i) => i.status === s).length;
    return {
      textRuns: runs.length,
      failingContrast: runs.filter((r) => !r.pass).length,
      minContrast: ratios.length ? Number(Math.min(...ratios).toFixed(4)) : null,
      justifiedRuns: runs.filter((r) => r.textAlign === 'justify').length,
      belowMinimumFontRuns: runs.filter((r) => r.fontSizePx < 16).length,
      images: {
        total: images.length,
        described: count('described'),
        declaredDecorative: count('declared-decorative'),
        autoDecorative: count('auto-decorative'),
        needsHuman: count('needs-human')
      },
      readingOrder: auditReadingOrder(target),
      runs,
      imageFindings: images.map(({ el, ...rest }) => rest)
    };
  }

  function stylesheet(face) {
    const family = face === 'opendyslexic'
      ? "'OpenDyslexic', 'OpenDyslexic3', 'Comic Sans MS', Verdana, sans-serif"
      : "'Atkinson Hyperlegible', 'Atkinson Hyperlegible Next', Verdana, 'DejaVu Sans', sans-serif";
    return `
html.lgb-on, html.lgb-on body { background: #ffffff !important; }
html.lgb-on body {
  font-family: ${family} !important;
  font-size: 19px !important;
  color: #1a1a1a !important;
  padding: 1.5rem !important;
  hyphens: none !important;
}
html.lgb-on body *:not(.lgb-summary):not(.lgb-summary *) {
  font-family: ${family} !important;
  text-align: left !important;
  line-height: 1.5 !important;
  letter-spacing: 0.12em !important;
  word-spacing: 0.16em !important;
  color: #1a1a1a !important;
  background-image: none !important;
  float: none !important;
  hyphens: none !important;
}
html.lgb-on p, html.lgb-on li, html.lgb-on td, html.lgb-on th, html.lgb-on blockquote {
  max-width: 66ch;
  padding: 0.35em 0.6em;
  margin-bottom: 2em;
}
html.lgb-on p.lgb-shade { background-color: #eef1f5 !important; }
html.lgb-on table, html.lgb-on tr, html.lgb-on td, html.lgb-on th { display: block !important; width: auto !important; }
html.lgb-on img { max-width: 100%; height: auto; }
html.lgb-on .lgb-alt-flag {
  border-left: 6px solid #8a1c1c;
  background-color: #fdecec !important;
  color: #5c0d0d !important;
  padding: 0.6em 0.9em;
  font-weight: 700;
  max-width: 66ch;
}
html.lgb-on .lgb-summary {
  border: 3px solid #1a3d6d;
  background-color: #eef3fb !important;
  color: #14243d !important;
  padding: 1em 1.2em;
  margin: 0 0 2em 0;
  max-width: 66ch;
}
`.trim();
  }

  function apply(doc, options) {
    const target = doc || global.document;
    const opts = options || {};
    const before = audit(target);
    if (target.getElementById(STYLE_ID)) revert(target);

    const style = target.createElement('style');
    style.id = STYLE_ID;
    style.textContent = stylesheet(opts.face);
    target.head.appendChild(style);
    target.documentElement.classList.add('lgb-on');

    // Author inline styles beat a stylesheet without !important and can beat one with it when
    // the author used !important too. They are stashed on the element and restored on revert,
    // so turning the extension off gives the page back exactly as it was.
    for (const el of target.querySelectorAll('[style]')) {
      if (el.closest('.lgb-summary, .lgb-alt-flag')) continue;
      if (!el.hasAttribute(MARK)) el.setAttribute(MARK, el.getAttribute('style'));
      el.removeAttribute('style');
    }
    for (const attr of ['bgcolor', 'color', 'align', 'width', 'height', 'face', 'size']) {
      for (const el of target.querySelectorAll(`[${attr}]`)) {
        if (el.tagName === 'IMG' && (attr === 'width' || attr === 'height')) continue;
        el.removeAttribute(attr);
      }
    }

    let shaded = 0;
    const paragraphs = [...target.querySelectorAll('p')].filter((p) => ownText(p) !== '' && !p.closest('.lgb-summary'));
    paragraphs.forEach((p, i) => { if (i % 2 === 1) { p.classList.add('lgb-shade'); shaded += 1; } });

    // Images with no usable alt get a visible flag. No alt text is invented, because this code
    // cannot see the image and a confident wrong description silently replaces information the
    // reader needed. A missing alt at least gets announced as missing.
    let flagged = 0;
    for (const finding of auditImages(target)) {
      if (finding.status === 'auto-decorative') {
        finding.el.setAttribute('alt', '');
        finding.el.setAttribute('role', 'presentation');
        continue;
      }
      if (finding.status !== 'needs-human') continue;
      const note = target.createElement('p');
      note.className = 'lgb-alt-flag';
      note.setAttribute('role', 'note');
      note.textContent = `Image needs a description written by a person. Source: ${finding.src || '(no src)'}. Reason: ${finding.reason}.`;
      finding.el.insertAdjacentElement('afterend', note);
      flagged += 1;
    }

    if (opts.summary && opts.summary.paragraphs && opts.summary.paragraphs.length) {
      const aside = target.createElement('aside');
      aside.className = 'lgb-summary';
      const h = target.createElement('h2');
      h.textContent = opts.summary.title || 'Plain language summary';
      aside.appendChild(h);
      const note = target.createElement('p');
      note.textContent = opts.summary.disclaimer
        || 'Written by a language model from the text below. It can be wrong. The full original text follows and has not been changed.';
      aside.appendChild(note);
      for (const para of opts.summary.paragraphs) {
        const p = target.createElement('p');
        p.textContent = para;
        aside.appendChild(p);
      }
      target.body.insertBefore(aside, target.body.firstChild);
    }

    const after = audit(target);
    return { before, after, shaded, flagged, target: TARGET };
  }

  function revert(doc) {
    const target = doc || global.document;
    const style = target.getElementById(STYLE_ID);
    if (style) style.remove();
    target.documentElement.classList.remove('lgb-on');
    for (const el of target.querySelectorAll(`[${MARK}]`)) {
      el.setAttribute('style', el.getAttribute(MARK));
      el.removeAttribute(MARK);
    }
    for (const el of target.querySelectorAll('.lgb-alt-flag, .lgb-summary')) el.remove();
    for (const el of target.querySelectorAll('.lgb-shade')) el.classList.remove('lgb-shade');
  }

  global.LegibleContent = { audit, apply, revert, stylesheet, effectiveBackground, auditReadingOrder };

  // Only wire up the browser messaging when running as a real extension. Loading this file in
  // a test page or a headless probe exercises the same functions without it.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (msg && msg.type === 'legible-audit') { respond({ ok: true, result: audit(document) }); return true; }
      if (msg && msg.type === 'legible-apply') { respond({ ok: true, result: apply(document, msg.options || {}) }); return true; }
      if (msg && msg.type === 'legible-revert') { revert(document); respond({ ok: true }); return true; }
      return false;
    });
  }
}(typeof globalThis === 'undefined' ? this : globalThis));
