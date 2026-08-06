import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from '../src/html/parse.js';
import { classifyImage, auditImages } from '../src/alt.js';

const img = (over) => classifyImage({
  src: 'photos/notice.jpg', alt: null, hasAlt: false, role: '', ariaHidden: false,
  width: null, height: null, ...over
});

test('a missing alt attribute needs a human, and no description is invented', () => {
  const v = img({ hasAlt: false });
  assert.equal(v.status, 'needs-human');
  assert.match(v.reason, /cannot see the image/);
});

test('alt="" on an informative image is a failure, not a pass', () => {
  // The subtlety this project exists for: alt="" is the CORRECT markup for a decorative image
  // and a silent information loss on an informative one. The attribute alone cannot tell them
  // apart, so an empty alt is read as the author's declaration and reported as such, never
  // counted as a described image.
  const v = img({ hasAlt: true, alt: '' });
  assert.equal(v.status, 'declared-decorative');
  assert.notEqual(v.status, 'described');
});

test('alt="" is correct for a decorative image and is not flagged', () => {
  const v = img({ src: 'images/rule.gif', hasAlt: true, alt: '', width: '600', height: '2' });
  assert.equal(v.status, 'declared-decorative');
  // The whole point: this is not an error. A checker that flags every empty alt would bury the
  // real findings under one false positive per divider line on the page.
  assert.notEqual(v.status, 'needs-human');
});

test('a placeholder alt says nothing and is caught', () => {
  for (const alt of ['image', 'Image', 'IMAGE', 'photo', 'picture', 'graphic', 'icon', 'logo',
    'img', 'untitled', 'banner', 'image1', 'images2', '   ']) {
    const v = img({ hasAlt: true, alt });
    assert.equal(v.status, alt.trim() === '' ? 'declared-decorative' : 'needs-human', `alt="${alt}"`);
  }
});

test('a filename as alt text is caught, in three shapes', () => {
  // Bare filename with an extension.
  assert.equal(img({ hasAlt: true, alt: 'agency_seal.png' }).status, 'needs-human');
  // Extension in upper case with trailing space, which a naive regex misses.
  assert.equal(img({ hasAlt: true, alt: 'Scan_0042.JPEG ' }).status, 'needs-human');
  // A full path that equals the src's basename, with no extension left to match on.
  assert.equal(img({ src: 'assets/DSC00219', hasAlt: true, alt: 'DSC00219' }).status, 'needs-human');
});

test('alt text shorter than three characters cannot be a description', () => {
  assert.equal(img({ hasAlt: true, alt: 'x' }).status, 'needs-human');
  assert.equal(img({ hasAlt: true, alt: 'ok' }).status, 'needs-human');
  assert.equal(img({ hasAlt: true, alt: 'Map' }).status, 'described');
});

test('real alt text is kept and never rewritten', () => {
  const v = img({ hasAlt: true, alt: 'The library front door with the ramp on the left' });
  assert.equal(v.status, 'described');
});

test('a spacer is proved decorative by evidence, not guessed', () => {
  // 1x1 pixel: the dimensions prove there is nothing to describe.
  const bySize = img({ src: 'assets/x.gif', hasAlt: false, width: '1', height: '1' });
  assert.equal(bySize.status, 'auto-decorative');
  assert.match(bySize.reason, /dimensions/);
  // A known spacer filename, at unknown size.
  const byName = img({ src: 'assets/dot_clear.gif', hasAlt: false });
  assert.equal(byName.status, 'auto-decorative');
  assert.match(byName.reason, /filename/);
  // A large image with an unremarkable name gets no such benefit of the doubt.
  assert.equal(img({ src: 'assets/chart.png', hasAlt: false, width: '600', height: '400' }).status, 'needs-human');
});

test('role=presentation and aria-hidden are honoured', () => {
  assert.equal(img({ hasAlt: false, role: 'presentation' }).status, 'declared-decorative');
  assert.equal(img({ hasAlt: false, role: 'none' }).status, 'declared-decorative');
  assert.equal(img({ hasAlt: false, ariaHidden: true }).status, 'declared-decorative');
});

test('auditImages counts a document and never counts a guess as resolved', () => {
  const root = parseHTML(`
    <p><img src="a.png" alt="A council chamber with a ramp at the rear"></p>
    <p><img src="b.png" alt=""></p>
    <p><img src="spacer.gif" width="1" height="1"></p>
    <p><img src="c.png" alt="c.png"></p>
    <p><img src="d.png"></p>
    <p><input type="image" src="submit.png"></p>
  `);
  const a = auditImages(root);
  assert.equal(a.total, 6, 'input type=image counts as an image');
  assert.equal(a.described, 1);
  assert.equal(a.declaredDecorative, 1);
  assert.equal(a.autoDecorative, 1);
  assert.equal(a.needsHuman, 3);
  assert.equal(a.resolved, 3);
  assert.equal(a.resolved + a.needsHuman, a.total, 'every image lands in exactly one bucket');
});
