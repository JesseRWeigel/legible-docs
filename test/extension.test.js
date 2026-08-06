// The extension restates the contrast and alt text rules as a plain script, because a
// Manifest V3 content script cannot import an ES module. Two copies of a rule drift, and a
// drifted copy here means the extension and the CLI disagree about whether a document is
// readable. These tests are what makes drift fail the suite instead of shipping.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as srcColor from '../src/color.js';
import { classifyImage as srcClassifyImage } from '../src/alt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');

// Load the extension script the way a browser would: as a plain script into a fresh global,
// with no module system available. If it ever grows an `import` it will throw here.
function loadCore() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'lib', 'legible-core.js'), 'utf8'), sandbox,
    { filename: 'legible-core.js' });
  assert.ok(sandbox.LegibleCore, 'legible-core.js must attach LegibleCore to the global');
  return sandbox.LegibleCore;
}

const C = loadCore();

// Objects built inside the sandbox have the sandbox's Object.prototype, and assert.deepEqual
// compares prototypes. Copying the own properties into a host object compares the values,
// which is what these tests are about.
const plain = (o) => (o === null || o === undefined ? o : { ...o });

// A deterministic spread of colours: the greys where the 4.5:1 boundary lives, the primaries,
// and a pseudo random sample with a fixed seed so a failure is reproducible.
function sampleColors() {
  const out = [];
  for (let v = 0; v <= 255; v += 1) out.push({ r: v, g: v, b: v, a: 1 });
  for (const c of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255],
    [26, 26, 26], [118, 118, 118], [119, 119, 119], [143, 180, 217], [10, 10, 10], [11, 11, 11]]) {
    out.push({ r: c[0], g: c[1], b: c[2], a: 1 });
  }
  let seed = 20260806;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 256; };
  for (let i = 0; i < 600; i += 1) out.push({ r: next(), g: next(), b: next(), a: 1 });
  return out;
}

test('the extension is loadable as a plain script, with no module syntax', () => {
  const source = fs.readFileSync(path.join(EXT, 'lib', 'legible-core.js'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'a content script cannot use import');
  assert.doesNotMatch(source, /^\s*export\s/m, 'a content script cannot use export');
  assert.doesNotMatch(source, /\brequire\s*\(/, 'a content script has no require');
});

test('channel linearisation is identical between the extension and the CLI', () => {
  for (let v = 0; v <= 255; v += 1) {
    assert.equal(C.channelToLinear(v), srcColor.channelToLinear(v), `channel ${v}`);
  }
});

test('relative luminance is identical for every sampled colour', () => {
  for (const c of sampleColors()) {
    assert.equal(C.relativeLuminance(c), srcColor.relativeLuminance(c), JSON.stringify(c));
  }
});

test('contrast ratio is identical across a large cross product', () => {
  const colors = sampleColors();
  let compared = 0;
  for (let i = 0; i < colors.length; i += 1) {
    const bg = colors[(i * 7 + 3) % colors.length];
    for (const fg of [colors[i], { r: 255, g: 255, b: 255, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }]) {
      assert.equal(C.contrastRatio(fg, bg), srcColor.contrastRatio(fg, bg),
        `${JSON.stringify(fg)} on ${JSON.stringify(bg)}`);
      compared += 1;
    }
  }
  assert.ok(compared > 2000, `only compared ${compared} pairs`);
});

test('the large text rule is identical, including at the exact thresholds', () => {
  assert.equal(C.LARGE_TEXT_PX, srcColor.LARGE_TEXT_PX);
  assert.equal(C.LARGE_TEXT_BOLD_PX, srcColor.LARGE_TEXT_BOLD_PX);
  for (const weight of [100, 300, 400, 500, 600, 700, 800, 900]) {
    for (let px = 8; px <= 32; px += 0.01) {
      const size = Number(px.toFixed(2));
      assert.equal(C.isLargeText(size, weight), srcColor.isLargeText(size, weight), `${size}px ${weight}`);
      assert.equal(C.requiredRatio(size, weight), srcColor.requiredRatio(size, weight), `${size}px ${weight}`);
    }
  }
});

test('alt text classification is identical, including the empty alt distinction', () => {
  const srcs = ['photos/notice.jpg', 'assets/dot_clear.gif', 'images/spacer.gif', 'x/DSC00219', ''];
  const alts = [null, '', '   ', 'image', 'Photo', 'agency_seal.png', 'Scan_0042.JPEG ', 'ok',
    'The council chamber with a ramp at the rear entrance', 'DSC00219'];
  const roles = ['', 'presentation', 'none', 'img'];
  const sizes = [[null, null], ['1', '1'], ['3', '3'], ['4', '4'], ['600', '400']];
  let compared = 0;
  for (const src of srcs) {
    for (const alt of alts) {
      for (const role of roles) {
        for (const [width, height] of sizes) {
          for (const ariaHidden of [false, true]) {
            const img = { src, alt, hasAlt: alt !== null, role, ariaHidden, width, height };
            assert.deepEqual(plain(C.classifyImage(img)), srcClassifyImage(img), JSON.stringify(img));
            compared += 1;
          }
        }
      }
    }
  }
  assert.ok(compared > 1000, `only compared ${compared} images`);
});

test('the extension parses the colour strings getComputedStyle returns', () => {
  // A browser normalises every colour to rgb() or rgba(), so those two must work whatever
  // else does.
  assert.deepEqual(plain(C.parseColor('rgb(118, 118, 118)')), { r: 118, g: 118, b: 118, a: 1 });
  assert.deepEqual(plain(C.parseColor('rgba(0, 0, 0, 0)')), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(plain(C.parseColor('rgba(255, 255, 255, 0.5)')), { r: 255, g: 255, b: 255, a: 0.5 });
  assert.deepEqual(plain(C.parseColor('#767676')), { r: 118, g: 118, b: 118, a: 1 });
  // And an unreadable value is null here too, never a silent black.
  for (const bad of ['', 'currentColor', 'var(--x)', 'color-mix(in srgb, red, blue)', null]) {
    assert.equal(C.parseColor(bad), null, `${JSON.stringify(bad)}`);
  }
});

test('compositing agrees with the CLI', () => {
  for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    const over = { r: 200, g: 100, b: 50, a };
    const under = { r: 20, g: 30, b: 40, a: 1 };
    assert.deepEqual(plain(C.composite(over, under)), srcColor.composite(over, under), `alpha ${a}`);
  }
});

test('the manifest points at files that exist and asks for no more than it needs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  for (const script of manifest.content_scripts[0].js) {
    assert.ok(fs.existsSync(path.join(EXT, script)), `content script ${script} is missing`);
  }
  assert.ok(fs.existsSync(path.join(EXT, manifest.action.default_popup)));
  // legible-core.js has to load before content.js, which throws without it.
  assert.deepEqual(manifest.content_scripts[0].js, ['lib/legible-core.js', 'content.js']);
  // No host permissions, no storage, no network. The extension reads and restyles the page in
  // front of the reader and sends nothing anywhere, which is the claim the README makes.
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
});

test('nothing in the extension makes a network request', () => {
  // The privacy claim in the README is checkable, so it gets checked. A benefit notice is not
  // something anyone should be uploading to a server to have it made readable.
  for (const file of ['lib/legible-core.js', 'content.js', 'popup.js']) {
    const source = fs.readFileSync(path.join(EXT, file), 'utf8');
    for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/,
      /navigator\.connection/, /\bimport\s*\(/]) {
      assert.doesNotMatch(source, pattern, `${file} must not contain ${pattern}`);
    }
  }
  const css = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  assert.doesNotMatch(css, /@import|https?:\/\//, 'the popup must not pull in a remote resource');
});
