import test from 'node:test';
import assert from 'node:assert/strict';
import { repairPair, shadeBand, scaleTowardBlack, scaleTowardWhite } from '../src/repair.js';
import { parseColor, toHex, contrastRatio, relativeLuminance } from '../src/color.js';

const c = (hex) => parseColor(hex);

test('t = 0 leaves a colour alone and t = 1 reaches the endpoint', () => {
  // Getting this convention backwards made the search report "unreachable" for colours that
  // reach 21:1 simply by going black, so it is pinned in both directions.
  assert.equal(toHex(scaleTowardBlack(c('#3366cc'), 0)), '#3366cc');
  assert.equal(toHex(scaleTowardBlack(c('#3366cc'), 1)), '#000000');
  assert.equal(toHex(scaleTowardWhite(c('#3366cc'), 0)), '#3366cc');
  assert.equal(toHex(scaleTowardWhite(c('#3366cc'), 1)), '#ffffff');
});

test('movement is monotone in t', () => {
  let prev = relativeLuminance(c('#3366cc'));
  for (let i = 1; i <= 10; i += 1) {
    const l = relativeLuminance(scaleTowardBlack(c('#3366cc'), i / 10));
    assert.ok(l <= prev + 1e-12, `darkening must not brighten at t=${i / 10}`);
    prev = l;
  }
});

test('a passing pair is returned untouched', () => {
  const r = repairPair(c('#1a1a1a'), c('#ffffff'), 4.5);
  assert.equal(r.met, true);
  assert.equal(r.direction, 'none');
  assert.deepEqual(r.changed, []);
  assert.equal(toHex(r.fg), '#1a1a1a');
});

test('a failing pair is moved until it meets the target, measured on the rounded result', () => {
  for (const [fg, bg] of [['#949494', '#ffffff'], ['#bfbfbf', '#f0f0f0'], ['#bcbcbc', '#ffffff'],
    ['#8fb4d9', '#ffffff'], ['#c08a8a', '#f0f0f0'], ['#a0a0a0', '#f0f0f0']]) {
    const r = repairPair(c(fg), c(bg), 4.5);
    assert.equal(r.met, true, `${fg} on ${bg} should be reachable`);
    // The claim is checked on the 8-bit colour that actually gets written, not on the
    // floating point candidate the bisection found.
    const actual = contrastRatio(parseColor(toHex(r.fg)), parseColor(toHex(r.bg)));
    assert.ok(actual >= 4.5, `${fg} on ${bg}: rounded result is ${actual.toFixed(4)}, under target`);
  }
});

test('the repair moves as little as it can', () => {
  const r = repairPair(c('#949494'), c('#ffffff'), 4.5);
  // Just past the target, not slammed to black. A repair that always returns #000000 would
  // pass every contrast check while destroying whatever the colour was carrying.
  const ratio = contrastRatio(r.fg, c('#ffffff'));
  assert.ok(ratio >= 4.5, `got ${ratio}`);
  assert.ok(ratio < 4.75, `moved further than needed, landed at ${ratio}`);
  assert.notEqual(toHex(r.fg), '#000000');
});

test('darkening keeps the hue, so a navy heading stays navy', () => {
  const r = repairPair(c('#6a8fd8'), c('#ffffff'), 4.5);
  assert.equal(r.direction, 'darkened-foreground');
  // Scaling the linear channels by one factor preserves the ratios between them exactly, so
  // the hue is unchanged. Checked as blue still dominating red and green in the same order.
  assert.ok(r.fg.b > r.fg.g && r.fg.g > r.fg.r, `channel order changed: ${toHex(r.fg)}`);
  const before = c('#6a8fd8');
  assert.ok(Math.abs((r.fg.r / r.fg.b) - (before.r / before.b)) < 0.06, 'red to blue ratio drifted');
});

test('text on a dark background is lightened, because darkening it would erase it', () => {
  // #3a3a3a has relative luminance 0.042. Black on it reaches only 1.85:1, so darkening is
  // not an option at all and the repair has to go the other way. A repair that always reaches
  // for black would return a colour that fails and looks like it tried.
  assert.ok(contrastRatio(c('#000000'), c('#3a3a3a')) < 4.5);
  const r = repairPair(c('#808080'), c('#3a3a3a'), 4.5);
  assert.equal(r.met, true);
  assert.equal(r.direction, 'lightened-foreground');
  assert.ok(relativeLuminance(r.fg) > relativeLuminance(c('#808080')));
  assert.ok(contrastRatio(parseColor(toHex(r.fg)), c('#3a3a3a')) >= 4.5);
});

test('when both directions work the smaller perceptual move wins', () => {
  // repairPair finds its answer by bisection. This checks the answer against a brute force
  // scan that shares none of that logic: step t in small increments, take the first candidate
  // in each direction that meets the target, and see which of the two moved less.
  const scan = (fg, bg, move) => {
    for (let t = 0; t <= 1.0000001; t += 0.0002) {
      const cand = parseColor(toHex(move(fg, t)));
      if (contrastRatio(cand, bg) >= 4.5) return cand;
    }
    return null;
  };
  // Both directions are open only for backgrounds whose relative luminance falls in the narrow
  // band [0.175, 0.1833], which among greys is exactly #757575 and #767676. Anywhere else one
  // of the two endpoints cannot reach 4.5:1 and there is no choice to make.
  const cases = [['#757575', '#767676'], ['#a0a0a0', '#757575'], ['#4a4a4a', '#767676']];
  let bothOpen = 0;
  for (const [fgHex, bgHex] of cases) {
    const fg = c(fgHex);
    const bg = c(bgHex);
    const dark = scan(fg, bg, scaleTowardBlack);
    const light = scan(fg, bg, scaleTowardWhite);
    if (!dark || !light) continue;
    bothOpen += 1;
    const r = repairPair(fg, bg, 4.5);
    assert.equal(r.met, true, `${fgHex} on ${bgHex}`);
    const dist = (x) => Math.abs(relativeLuminance(x) - relativeLuminance(fg));
    // A near tie can legitimately fall either way, so the direction is only asserted when the
    // two distances are clearly apart.
    if (Math.abs(dist(dark) - dist(light)) > 1e-3) {
      const expected = dist(dark) < dist(light) ? 'darkened-foreground' : 'lightened-foreground';
      assert.equal(r.direction, expected, `${fgHex} on ${bgHex}: wrong direction chosen`);
    }
    // And the move itself is no larger than the brute force minimum, allowing for the step.
    assert.ok(dist(r.fg) <= Math.min(dist(dark), dist(light)) + 1e-3,
      `${fgHex} on ${bgHex}: moved ${dist(r.fg)}, brute force found ${Math.min(dist(dark), dist(light))}`);
  }
  assert.ok(bothOpen > 0, 'no case exercised the two-direction choice, the test proved nothing');
});

test('at 4.5:1 the foreground can always get there, so the background never has to move', () => {
  // A background needs luminance above 0.1833 for black text to fail, and below 0.175 for
  // white text to fail. No colour is both, so the background-moving branch is dead at 4.5.
  for (let v = 0; v <= 255; v += 1) {
    const bg = { r: v, g: v, b: v, a: 1 };
    const r = repairPair({ r: 128, g: 128, b: 128, a: 1 }, bg, 4.5);
    assert.equal(r.met, true, `grey ${v} unreachable at 4.5:1`);
    assert.notEqual(r.direction, 'moved-background', `grey ${v} needed a background move at 4.5:1`);
  }
});

test('at 7:1 the background does have to move, and then the pair still meets the target', () => {
  // #808080 has relative luminance 0.2159. Black on it is 5.32:1 and white on it is 3.95:1,
  // so neither endpoint reaches 7:1 and the background is the only remaining lever.
  assert.ok(contrastRatio(c('#000000'), c('#808080')) < 7);
  assert.ok(contrastRatio(c('#ffffff'), c('#808080')) < 7);
  const r = repairPair(c('#000000'), c('#808080'), 7);
  assert.equal(r.direction, 'moved-background');
  assert.equal(r.met, true);
  assert.deepEqual(r.changed, ['foreground', 'background']);
  assert.ok(contrastRatio(parseColor(toHex(r.fg)), parseColor(toHex(r.bg))) >= 7);
});

test('an unreachable target reports failure instead of a colour that does not meet it', () => {
  // 25:1 is above the 21:1 maximum any sRGB pair can reach.
  const r = repairPair(c('#808080'), c('#808080'), 25);
  assert.equal(r.met, false);
  assert.equal(r.direction, 'unreachable');
});

test('the shading band is visible against the page and still readable underneath the text', () => {
  const band = shadeBand(c('#ffffff'), c('#1a1a1a'), 4.5);
  assert.equal(band.ok, true);
  assert.ok(band.bandContrast >= 1.06, `band is invisible at ${band.bandContrast}`);
  assert.ok(band.textContrast >= 4.5, `text on the band is only ${band.textContrast}`);
  // Measured again from the returned hex, so the reported numbers describe the colour that
  // actually gets written into the stylesheet.
  assert.ok(contrastRatio(parseColor(band.hex), c('#ffffff')) >= 1.06);
  assert.ok(contrastRatio(c('#1a1a1a'), parseColor(band.hex)) >= 4.5);
});

test('the band gives up rather than returning one that hides the text', () => {
  // Text this pale cannot survive any visible band on white, so the function must say so.
  const band = shadeBand(c('#ffffff'), c('#767676'), 4.5);
  assert.equal(band.ok, false);
  assert.equal(band.hex, '#ffffff', 'no band is better than a band that breaks the text');
});

test('the search stops at the first visible band instead of hunting for a darker one', () => {
  // A shading band is a subtle variation on the page colour. The search walks away from the
  // page in small steps and stops as soon as the band is visible, whether or not the text
  // still passes on it.
  //
  // Without that stop the loop keeps going and can find a "band" far down the range that
  // satisfies both numbers by being a completely different colour. On a #323232 page it
  // returns #999999, a light grey block at 4.5:1 against the page. That is a colour inversion
  // rather than paragraph shading, and both of its measured numbers look fine.
  const dark = shadeBand(c('#323232'), c('#323232'), 4.5);
  assert.equal(dark.ok, false, `expected no band, got ${dark.hex} at ${dark.bandContrast}:1 against the page`);

  // The general property, over a spread of page and text colours: any band that IS returned
  // has to stay near the page. 1.5:1 is far looser than the bands actually chosen and still
  // rules out an inversion by an order of magnitude.
  let returned = 0;
  for (let page = 0; page <= 255; page += 5) {
    for (let text = 0; text <= 255; text += 5) {
      const band = shadeBand({ r: page, g: page, b: page, a: 1 }, { r: text, g: text, b: text, a: 1 }, 4.5);
      if (!band.ok) continue;
      returned += 1;
      assert.ok(band.bandContrast < 1.5,
        `page #${page.toString(16)} text #${text.toString(16)}: band ${band.hex} sits at `
        + `${band.bandContrast.toFixed(2)}:1 against the page, which is a block and not shading`);
    }
  }
  assert.ok(returned > 100, `only ${returned} band(s) were returned, the sweep proved little`);
});
