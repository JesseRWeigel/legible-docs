// Image text alternatives.
//
// This module never writes alt text for an image whose content it cannot see. A confidently
// wrong alt text is worse than a missing one: a missing alt is reported by every checker and
// by the screen reader itself, while "Photo of a document" on a photo of a deadline notice
// silently replaces information the reader needed. The only case handled automatically is a
// spacer image, where the pixel dimensions or the filename prove there is nothing to describe.

import { findAll } from './html/parse.js';

export const SPACER_NAMES = /(^|[/_-])(spacer|pixel|blank|clear|shim|dot|transparent)([._-]|$)/i;
export const PLACEHOLDER_ALT = /^(image|images?\d*|photo|picture|graphic|icon|logo|img|untitled|photograph|banner|spacer|\s*)$/i;
export const FILENAME_ALT = /\.(jpe?g|png|gif|webp|svg|bmp|tiff?)\s*$/i;

function intAttr(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/px$/i, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function looksLikeSpacer({ width, height, src }) {
  const w = intAttr(width);
  const h = intAttr(height);
  if (w !== null && h !== null && w <= 3 && h <= 3) return 'dimensions prove it carries no content';
  if (SPACER_NAMES.test(String(src || '').split('?')[0])) return 'filename matches a known spacer pattern';
  return null;
}

/**
 * Pure classification of one image from its attributes. The CLI calls it with values pulled
 * out of the parsed tree and the browser extension calls it with values pulled off a live
 * DOM node, so both paths reach the same verdict from the same rules.
 * @param {{src: string, alt: string|null, hasAlt: boolean, role: string, ariaHidden: boolean,
 *          width: string|number|null, height: string|number|null}} img
 */
export function classifyImage(img) {
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

/**
 * Classify every image. Statuses:
 *   described          alt present, specific enough to keep
 *   declared-decorative author already marked it decorative (alt="" or role=presentation)
 *   auto-decorative    a spacer this tool can mark decorative from evidence, not from a guess
 *   needs-human        no usable alt, and the tool refuses to invent one
 */
export function auditImages(root) {
  const images = findAll(root, (n) => n.type === 'element' && (n.tag === 'img' || (n.tag === 'input' && (n.attrs.type || '').toLowerCase() === 'image')));
  const findings = images.map((img, index) => {
    const verdict = classifyImage({
      src: img.attrs.src || '',
      alt: Object.prototype.hasOwnProperty.call(img.attrs, 'alt') ? String(img.attrs.alt) : null,
      hasAlt: Object.prototype.hasOwnProperty.call(img.attrs, 'alt'),
      role: img.attrs.role || '',
      ariaHidden: (img.attrs['aria-hidden'] || '').toLowerCase() === 'true',
      width: img.attrs.width,
      height: img.attrs.height
    });
    return {
      index,
      src: img.attrs.src || '',
      alt: Object.prototype.hasOwnProperty.call(img.attrs, 'alt') ? String(img.attrs.alt) : null,
      node: img,
      status: verdict.status,
      reason: verdict.reason
    };
  });

  const count = (s) => findings.filter((f) => f.status === s).length;
  return {
    findings,
    total: findings.length,
    described: count('described'),
    declaredDecorative: count('declared-decorative'),
    autoDecorative: count('auto-decorative'),
    needsHuman: count('needs-human'),
    // Coverage counts an image as resolved when it has real alt text or is provably
    // decorative. It never counts an image that this tool merely guessed about.
    resolved: count('described') + count('declared-decorative') + count('auto-decorative')
  };
}
