import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColor, toHex, channelToLinear, relativeLuminance, contrastRatio, composite,
  isLargeText, requiredRatio, LARGE_TEXT_PX, LARGE_TEXT_BOLD_PX, PX_PER_PT
} from '../src/color.js';

const close = (actual, expected, tol, what) => {
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, expected ${expected} within ${tol}`);
};

test('sRGB linearisation uses the 0.03928 branch, not a plain gamma curve', () => {
  // 0.03928 * 255 = 10.0164, so channel value 10 is on the linear segment and 11 is not.
  // Linear segment:  10/255 / 12.92                      = 0.0030352698...
  // Gamma segment:  ((11/255 + 0.055) / 1.055) ** 2.4    = 0.0033465357...
  close(channelToLinear(10), (10 / 255) / 12.92, 1e-15, 'channel 10 on the linear segment');
  close(channelToLinear(11), ((11 / 255 + 0.055) / 1.055) ** 2.4, 1e-15, 'channel 11 on the gamma segment');
  // The two segments meet, so there is no step at the crossover.
  const at = 0.03928 * 255;
  close(channelToLinear(at), (at / 255) / 12.92, 1e-12, 'value at the threshold');
  close(channelToLinear(at + 1e-9), (at / 255) / 12.92, 1e-6, 'value just past the threshold');
});

test('relative luminance matches hand computation for three colours', () => {
  // #767676: every channel is 0x76 = 118. 118/255 = 0.462745..., above 0.03928, so
  //   linear = ((0.462745 + 0.055) / 1.055) ** 2.4 = 0.1811642442...
  //   L = (0.2126 + 0.7152 + 0.0722) * 0.1811642442 = 0.1811642442 (weights sum to 1)
  close(relativeLuminance(parseColor('#767676')), 0.1811642442, 1e-9, '#767676');
  // #0000ff: red and green are 0, blue is 1.0 whose linear value is 1.0.
  //   L = 0.0722 * 1 = 0.0722 exactly.
  close(relativeLuminance(parseColor('#0000ff')), 0.0722, 1e-15, '#0000ff');
  // #f0f0f0: 240/255 = 0.941176..., linear = ((0.941176 + 0.055)/1.055) ** 2.4 = 0.8713671192
  close(relativeLuminance(parseColor('#f0f0f0')), 0.8713671192, 1e-9, '#f0f0f0');
});

test('contrast ratio matches hand computation, including the +0.05 offsets', () => {
  // (1.0 + 0.05) / (0.0 + 0.05) = 21 exactly. Without the offsets this would be infinite.
  close(contrastRatio(parseColor('#000000'), parseColor('#ffffff')), 21, 1e-12, 'black on white');
  // (1.0 + 0.05) / (0.1811642442 + 0.05) = 1.05 / 0.2311642442 = 4.542225...
  close(contrastRatio(parseColor('#767676'), parseColor('#ffffff')), 4.5422247, 1e-6, '#767676 on white');
  // (0.8713671192 + 0.05) / (0.5209955732 + 0.05) = 0.9213671192 / 0.5709955732 = 1.613615...
  close(contrastRatio(parseColor('#bfbfbf'), parseColor('#f0f0f0')), 1.6136152, 1e-6, '#bfbfbf on #f0f0f0');
  // Order does not matter: the formula always puts the lighter colour on top.
  close(contrastRatio(parseColor('#ffffff'), parseColor('#767676')), 4.5422247, 1e-6, 'arguments reversed');
});

test('the 4.5:1 boundary lands between two adjacent greys', () => {
  // This is the pair that a simplified luminance formula gets wrong. #767676 is the darkest
  // grey that passes on white and #777777 is one step lighter and fails.
  assert.ok(contrastRatio(parseColor('#767676'), parseColor('#ffffff')) >= 4.5, '#767676 passes');
  assert.ok(contrastRatio(parseColor('#777777'), parseColor('#ffffff')) < 4.5, '#777777 fails');
});

test('a luminance formula without linearisation would move colours across the threshold', () => {
  // Guards against someone "simplifying" relativeLuminance later. The naive weighted average
  // of the raw 0..1 channels reports #767676 on white as 2.05:1 rather than 4.54:1, which
  // would fail a colour that passes. Both errors matter, and this pins the correct one.
  const naive = (rgb) => (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  const grey = parseColor('#767676');
  const white = parseColor('#ffffff');
  const naiveRatio = (1 + 0.05) / (naive(grey) + 0.05);
  close(naiveRatio, 2.0478, 1e-3, 'the wrong answer');
  assert.ok(naiveRatio < 4.5 && contrastRatio(grey, white) >= 4.5,
    'the naive formula and the correct one disagree about whether #767676 passes');
});

test('large text thresholds come from points, exactly', () => {
  close(PX_PER_PT, 96 / 72, 1e-15, 'px per pt');
  close(LARGE_TEXT_PX, 24, 1e-12, '18pt in px');
  close(LARGE_TEXT_BOLD_PX, 18.666666666666668, 1e-12, '14pt in px');
});

test('the large text exception applies at 18pt, or at 14pt when bold', () => {
  // Normal weight: only 24px and up is large.
  assert.equal(isLargeText(23.9, 400), false);
  assert.equal(isLargeText(24, 400), true);
  assert.equal(requiredRatio(23.9, 400), 4.5);
  assert.equal(requiredRatio(24, 400), 3);
  // Bold: 18.6667px and up is large.
  assert.equal(isLargeText(18.6, 700), false);
  assert.equal(isLargeText(18.67, 700), true);
  assert.equal(requiredRatio(18.6, 700), 4.5);
  assert.equal(requiredRatio(18.67, 700), 3);
  // 18.66px bold is 13.995pt, under 14pt, so it does NOT get the allowance. A checker that
  // rounds the threshold down to 18.66 would wrongly pass it at 3:1.
  assert.equal(isLargeText(18.66, 700), false, '18.66px bold is under 14pt');
  // Weight below 700 gets no bold allowance however large the "bold-ish" number looks.
  assert.equal(isLargeText(20, 600), false);
  assert.equal(isLargeText(20, 700), true);
  assert.equal(isLargeText(20, 900), true);
});

test('one threshold for everything would be wrong in both directions', () => {
  const fg = parseColor('#949494');
  const bg = parseColor('#ffffff');
  const ratio = contrastRatio(fg, bg);
  close(ratio, 3.0334698, 1e-6, '#949494 on white');
  // At 24px this passes because large text needs 3:1. At 16px it fails.
  assert.ok(ratio >= requiredRatio(24, 400), '24px passes');
  assert.ok(ratio < requiredRatio(16, 400), '16px fails');
});

test('parseColor reads the formats real documents use', () => {
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('#AABBCC'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parseColor('rgb(100%, 0%, 0%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('WHITE'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('hsl(120, 100%, 25%)'), { r: 0, g: 128, b: 0, a: 1 });
  assert.equal(parseColor('transparent').a, 0);
});

test('an unreadable colour is null, never a silent black', () => {
  // "could not read this" and "the colour is black" must not collapse into one value, because
  // black is the highest contrast colour there is and would turn a failure into a pass.
  for (const bad of ['', '   ', 'currentColor', 'var(--brand)', 'url(x.png)', '#ff', 'rgb(a,b,c)', null, undefined]) {
    assert.equal(parseColor(bad), null, `${JSON.stringify(bad)} must be null`);
  }
});

test('translucent text is composited before it is measured', () => {
  const half = { r: 0, g: 0, b: 0, a: 0.5 };
  const onWhite = composite(half, { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(onWhite, { r: 127.5, g: 127.5, b: 127.5, a: 1 });
  // Measuring the declared colour instead of the painted one reports 21:1 for text that is
  // actually at 3.98:1.
  close(contrastRatio(onWhite, { r: 255, g: 255, b: 255, a: 1 }), 3.9766530, 1e-6, 'painted ratio');
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }), 21);
});

test('toHex round trips', () => {
  for (const hex of ['#000000', '#ffffff', '#767676', '#0a1b2c']) {
    assert.equal(toHex(parseColor(hex)), hex);
  }
});
