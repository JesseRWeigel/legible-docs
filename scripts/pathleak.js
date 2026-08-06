// Detect filesystem paths in text that is about to be used as a measurement.
//
// This lives in its own module rather than inline in fingerprint.js so it can be unit tested.
// It guards the property the whole sabotage harness rests on: the fingerprint must depend on
// the CODE and not on where the checkout happens to sit. A fingerprint containing an absolute
// path differs between two copies of the same tree, which makes the sabotage harness's null
// control fail, and if the null control were ever weakened it would make every sabotage score
// as proven while proving nothing.
//
// It is also the reason an absolute path never reaches the README: verify output gets pasted
// there, and /home/<someone>/... is both private and unportable.

// Each pattern is anchored on a separator so a bare word like "tmp" or "users" in prose does
// not match. `file://` has no trailing separator requirement because the scheme is already
// unambiguous.
const PATTERNS = [
  { name: 'unix home directory', re: /\/home\/[A-Za-z0-9._-]+/ },
  { name: 'macOS home directory', re: /\/Users\/[A-Za-z0-9._-]+/ },
  { name: 'temporary directory', re: /\/tmp\/[A-Za-z0-9._-]+/ },
  { name: 'private var directory', re: /\/private\/var\/[A-Za-z0-9._-]+/ },
  { name: 'Windows drive path', re: /\b[A-Za-z]:\\\\?[A-Za-z0-9._-]+/ },
  { name: 'file URL', re: /file:\/\/\S/ },
  { name: 'tilde home directory', re: /(^|[\s"'([:,])~\/[A-Za-z0-9._-]+/ }
];

/**
 * @param {string} text
 * @returns {{name: string, match: string, index: number}|null} the first leak, or null.
 * Null means "checked and found nothing". There is no third value, because a check that
 * cannot distinguish "clean" from "did not run" is the failure this project is about.
 */
export function findPathLeak(text) {
  const s = String(text);
  let best = null;
  for (const { name, re } of PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    if (best === null || m.index < best.index) {
      best = { name, match: m[0], index: m.index };
    }
  }
  return best;
}

export const PATH_LEAK_PATTERNS = PATTERNS.map((p) => p.name);
