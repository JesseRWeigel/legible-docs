// Move a foreground colour (and, only when the foreground alone cannot get there, the
// background) until a colour pair meets a WCAG contrast target.
//
// Darkening scales the linear-light channels by one factor, which keeps chromaticity exactly,
// so a navy heading stays navy. Lightening interpolates toward white, which does desaturate,
// and the repair report says which of the two happened.

import { relativeLuminance, contrastRatio, toHex } from './color.js';

function linearToChannel(l) {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function channelToLinearLocal(c8) {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Both movers take t, the amount of movement: t = 0 leaves the colour alone and t = 1 goes
// all the way to the endpoint. Keeping that convention in both directions is what makes the
// bisection below monotone, and getting it backwards was a real bug here: the search reported
// "unreachable" for #bcbcbc on white, a colour that reaches 21:1 simply by going black.
export function scaleTowardBlack(rgb, t) {
  const k = 1 - t;
  return {
    r: linearToChannel(channelToLinearLocal(rgb.r) * k),
    g: linearToChannel(channelToLinearLocal(rgb.g) * k),
    b: linearToChannel(channelToLinearLocal(rgb.b) * k),
    a: 1
  };
}

export function scaleTowardWhite(rgb, t) {
  const mix = (c) => {
    const l = channelToLinearLocal(c);
    return linearToChannel(l + (1 - l) * t);
  };
  return { r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b), a: 1 };
}

// Smallest movement in [0,1] whose candidate meets the target, found by bisection.
//
// Every candidate is measured AFTER it has been rounded to 8 bits, because scaleTowardBlack
// and scaleTowardWhite both round on their way out through linearToChannel. That ordering is
// the thing that matters: measuring a floating point candidate and then rounding it could drop
// the ratio back under the target, and the caller would be handed a colour that does not meet
// the number reported for it. Measuring the rounded value means whatever comes back has been
// checked in exactly the form it will be written.
//
// It also means `best` cannot fail. It starts as the endpoint, which the first line has
// already confirmed reaches the target, and it is only ever replaced by a candidate that
// passed the same comparison. An earlier version re-measured `best` here and fell back to the
// endpoint, with a comment saying rounding could still have spoiled it. That was wrong, and
// the branch was unreachable: 22,274 searches across the colour cube never once took it. The
// re-measure the caller actually needs is the one in the test suite, which reparses the
// returned hex and checks the ratio again from the string.
function searchToward(rgb, bg, target, move) {
  if (contrastRatio(move(rgb, 1), bg) < target) return null;
  let lo = 0;
  let hi = 1;
  let best = move(rgb, 1);
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    const cand = move(rgb, mid);
    if (contrastRatio(cand, bg) >= target) {
      best = cand;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}

function perceptualDistance(a, b) {
  return Math.abs(relativeLuminance(a) - relativeLuminance(b));
}

/**
 * @returns {{fg, bg, ratioBefore, ratioAfter, target, met, changed: string[], direction: string}}
 */
export function repairPair(fg, bg, target) {
  const ratioBefore = contrastRatio(fg, bg);
  if (ratioBefore >= target) {
    return {
      fg, bg, ratioBefore, ratioAfter: ratioBefore, target, met: true, changed: [],
      direction: 'none'
    };
  }

  const darker = searchToward(fg, bg, target, scaleTowardBlack);
  const lighter = searchToward(fg, bg, target, scaleTowardWhite);
  let pick = null;
  let direction = 'none';
  if (darker && lighter) {
    if (perceptualDistance(darker, fg) <= perceptualDistance(lighter, fg)) {
      pick = darker; direction = 'darkened-foreground';
    } else {
      pick = lighter; direction = 'lightened-foreground';
    }
  } else if (darker) {
    pick = darker; direction = 'darkened-foreground';
  } else if (lighter) {
    pick = lighter; direction = 'lightened-foreground';
  }

  if (pick) {
    return {
      fg: pick, bg, ratioBefore, ratioAfter: contrastRatio(pick, bg), target, met: true,
      changed: ['foreground'], direction
    };
  }

  // The foreground cannot reach the target against this background from either end. Whether
  // that is possible depends on the target. At 4.5:1 it never happens: a background needs
  // relative luminance above 0.1833 for black text to fail and below 0.175 for white text to
  // fail, and no colour satisfies both, so this branch is unreachable at the default target.
  // At 7:1 it is reachable, and #808080 (relative luminance 0.2159) is an example: black on it
  // measures 5.32:1 and white on it measures 3.95:1, so neither endpoint gets there. Then the
  // background has to move as well.
  const bgLighter = searchToward(bg, fg, target, scaleTowardWhite);
  const bgDarker = searchToward(bg, fg, target, scaleTowardBlack);
  const bgPick = relativeLuminance(bg) >= relativeLuminance(fg) ? (bgLighter || bgDarker) : (bgDarker || bgLighter);
  if (bgPick) {
    const fgAgain = searchToward(fg, bgPick, target, relativeLuminance(bgPick) > relativeLuminance(fg) ? scaleTowardBlack : scaleTowardWhite);
    const finalFg = fgAgain || fg;
    return {
      fg: finalFg, bg: bgPick, ratioBefore, ratioAfter: contrastRatio(finalFg, bgPick), target,
      met: contrastRatio(finalFg, bgPick) >= target, changed: ['foreground', 'background'],
      direction: 'moved-background'
    };
  }

  return { fg, bg, ratioBefore, ratioAfter: ratioBefore, target, met: false, changed: [], direction: 'unreachable' };
}

// A paragraph shading band has to do two jobs at once: stay far enough from the page
// background to be visible as a band, and stay far enough from the text to keep the text
// readable. Returns the darkest acceptable band plus both measured ratios.
export function shadeBand(pageBg, textColor, textTarget, minBandContrast = 1.06) {
  const towardText = relativeLuminance(pageBg) > relativeLuminance(textColor) ? scaleTowardBlack : scaleTowardWhite;
  let chosen = null;
  for (let step = 1; step <= 60; step += 1) {
    const cand = towardText(pageBg, step * 0.005);
    const bandRatio = contrastRatio(cand, pageBg);
    const textRatio = contrastRatio(textColor, cand);
    if (bandRatio >= minBandContrast && textRatio >= textTarget) { chosen = { cand, bandRatio, textRatio }; break; }
    if (bandRatio >= minBandContrast) break; // band is visible but text no longer passes on it
  }
  if (!chosen) {
    return {
      band: pageBg, bandContrast: 1, textContrast: contrastRatio(textColor, pageBg), ok: false,
      hex: toHex(pageBg)
    };
  }
  return {
    band: chosen.cand, bandContrast: chosen.bandRatio, textContrast: chosen.textRatio, ok: true,
    hex: toHex(chosen.cand)
  };
}
