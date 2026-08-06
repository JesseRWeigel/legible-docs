#!/usr/bin/env python3
"""Break the tool on purpose and require the checks to notice.

THE THREE-GATE RULE. A sabotage counts as proven only if all three hold, in order:

  gate 1  IT APPLIES.  The patch changed the file. An attack that silently did nothing is the
          most common way a harness like this lies to you. `KNOWN = [] or [...]` evaluates to
          the second operand and empties nothing; patching a field the renderer does not read
          changes no output. Both were written up here as "the verify has a gap".
  gate 2  IT CHANGES THE MEASURED OUTPUT.  The fingerprint moved. If the code changed but the
          measurement did not, the sabotage reached dead code and proves nothing about the
          checks.
  gate 3  IT IS CAUGHT.  The named detector exits nonzero.

A sabotage that fails gate 1 or gate 2 is reported as a FAILURE OF THE HARNESS, not as a gap
in the verify, and not as a pass. That distinction is the entire point of this file.

THE NULL CONTROL runs first and is not optional. An unchanged copy of the tree, in a different
directory, must fingerprint identically to the baseline. If it does not, the fingerprint is
tracking the working directory rather than the code, gate 2 then passes automatically for every
sabotage, and every result in the run is void. The run aborts rather than reporting eleven
proven sabotages that proved nothing.

DORMANT SABOTAGES invert gate 2, and they are marked `'dormant': True` in the list below.
Two kinds of change land here. One is removing a guard that never fires when the input is
correct, such as the error raised for a file that is not a PDF. The other is breaking something
the corpus fingerprint does not cover, such as the extension, whose code the command line tool
never loads. Both change no fingerprint, so requiring it to move would be wrong. For these the
requirement is the opposite: the output must be UNCHANGED and the named detector must still
FAIL, which is what proves the code was covered by a test rather than merely present.

Deciding this per sabotage rather than per list matters. Twelve of the entries below were
written as plain sabotages, scored as harness failures on the first full run because the
fingerprint did not move, and only then turned out to be dormant. Two others looked dormant and
were real gaps: the corpus had no image with alt="" and no text in a bare <div>, so two
genuinely broken behaviours went unnoticed. Both documents were extended rather than the
sabotages weakened.

    python3 scripts/sabotage.py             run everything
    python3 scripts/sabotage.py --list      names only
    python3 scripts/sabotage.py --only NAME run one
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


# ------------------------------------------------------------------------------------------
# Sabotage definitions. Each `old` string is an exact anchor in the file. If an anchor stops
# matching, gate 1 fails loudly rather than the sabotage quietly becoming a no-op.
# ------------------------------------------------------------------------------------------

SABOTAGES = [
    {
        'name': 'luminance-no-linearisation',
        'file': 'src/color.js',
        'old': '  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);',
        'new': '  return c;',
        'detector': 'independent',
        'why': 'Drops the sRGB transfer function and uses the raw channel. This is the classic '
               'simplified luminance: #767676 on white reads 2.05:1 instead of 4.54:1.',
    },
    {
        'name': 'luminance-threshold-removed',
        'file': 'src/color.js',
        'old': '  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);',
        'new': '  return Math.pow((c + 0.055) / 1.055, 2.4);',
        'detector': 'tests',
        'why': 'Keeps the gamma curve but drops the 0.03928 linear segment, which is the subtle '
               'version of the same bug and only shows on very dark channels.',
    },
    {
        'name': 'contrast-offset-removed',
        'file': 'src/color.js',
        'old': '  return (light + 0.05) / (dark + 0.05);',
        'new': '  return (light + 0.0001) / (dark + 0.0001);',
        'detector': 'independent',
        'why': 'Removes the +0.05 flare offsets, which inflates every ratio involving a dark '
               'colour and turns failing pairs into passing ones.',
    },
    {
        'name': 'contrast-weights-equal',
        'file': 'src/color.js',
        'old': '  return 0.2126 * channelToLinear(rgb.r) + 0.7152 * channelToLinear(rgb.g) + 0.0722 * channelToLinear(rgb.b);',
        'new': '  return (channelToLinear(rgb.r) + channelToLinear(rgb.g) + channelToLinear(rgb.b)) / 3;',
        'detector': 'independent',
        'why': 'Weights the channels equally instead of by luminous efficiency, which is wrong '
               'for every colour that is not grey.',
    },
    {
        'name': 'large-text-one-threshold',
        'file': 'src/color.js',
        'old': '  return isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;',
        'new': '  return 3;',
        'detector': 'independent',
        'why': 'Applies the 3:1 large text allowance to all text. One threshold for everything '
               'is the mistake the large text exception exists to prevent.',
    },
    {
        'name': 'large-text-ignores-weight',
        'file': 'src/color.js',
        'old': '  return weight >= 700 && fontSizePx >= LARGE_TEXT_BOLD_PX;',
        'new': '  return fontSizePx >= LARGE_TEXT_BOLD_PX;',
        'detector': 'tests',
        'why': 'Gives non-bold text at 14pt the bold allowance, so 19px regular text is judged '
               'at 3:1 when WCAG asks for 4.5:1.',
    },
    {
        'name': 'large-text-bold-threshold-rounded',
        'file': 'src/color.js',
        'old': 'export const LARGE_TEXT_BOLD_PX = 14 * PX_PER_PT;',
        'new': 'export const LARGE_TEXT_BOLD_PX = 18.66;',
        'detector': 'tests',
        'why': 'The rounding this project deliberately avoids. 18.66px is 13.995pt, under the '
               '14pt WCAG asks for, so bold text there wrongly gets the 3:1 allowance.',
    },
    {
        'name': 'unparsed-colour-becomes-black',
        'dormant': True,
        'file': 'src/color.js',
        'old': "  if (s === '') return null;",
        'new': "  if (s === '') return { r: 0, g: 0, b: 0, a: 1 };",
        'detector': 'tests',
        'why': 'Collapses "could not read this colour" into "the colour is black". Black is the '
               'highest contrast colour there is, so every unreadable colour becomes a pass.',
    },
    {
        'name': 'alpha-ignored-in-compositing',
        'dormant': True,
        'file': 'src/color.js',
        'old': '  if (a >= 1) return { r: over.r, g: over.g, b: over.b, a: 1 };',
        'new': '  return { r: over.r, g: over.g, b: over.b, a: 1 };',
        'detector': 'tests',
        'why': 'Measures a translucent colour as declared rather than as painted, so white text '
               'at 50% opacity on white is reported at 1:1 when it is really 3.98:1, and the '
               'reverse case reports a pass on unreadable text.',
    },
    {
        'name': 'empty-alt-counted-as-described',
        'file': 'src/alt.js',
        'old': "  if (role === 'presentation' || role === 'none' || img.ariaHidden || (hasAlt && alt.trim() === '')) {\n    return { status: 'declared-decorative', reason: 'author marked it decorative' };\n  }",
        'new': "  if (role === 'presentation' || role === 'none' || img.ariaHidden) {\n    return { status: 'declared-decorative', reason: 'author marked it decorative' };\n  }\n  if (hasAlt && alt.trim() === '') return { status: 'described', reason: 'alt text present' };",
        'detector': 'independent',
        'why': 'Counts an empty alt as a real description. An informative image with alt="" then '
               'reports as resolved and the reader gets nothing.',
    },
    {
        'name': 'placeholder-alt-accepted',
        'file': 'src/alt.js',
        'old': '    if (PLACEHOLDER_ALT.test(trimmed) || FILENAME_ALT.test(trimmed) || trimmed === src.split(\'/\').pop()) {',
        'new': '    if (false) {',
        'detector': 'independent',
        'why': 'Accepts alt="image" and alt="seal.png" as descriptions. The checker then only '
               'verifies that the attribute exists, which is the shallow check this project '
               'exists to be better than.',
    },
    {
        'name': 'filename-alt-accepted',
        'dormant': True,
        'file': 'src/alt.js',
        'old': "export const FILENAME_ALT = /\\.(jpe?g|png|gif|webp|svg|bmp|tiff?)\\s*$/i;",
        'new': "export const FILENAME_ALT = /^\\u0000never-matches$/;",
        'detector': 'tests',
        'why': 'Only the filename-as-alt rule is disabled, leaving the placeholder rule intact, '
               'so this proves the two rules are tested separately rather than together.',
    },
    {
        'name': 'missing-alt-invented',
        'file': 'src/alt.js',
        'old': "  return {\n    status: 'needs-human',\n    reason: 'no alt attribute, and this tool cannot see the image, so a human has to write it'\n  };",
        'new': "  return { status: 'described', reason: 'alt text present' };",
        'detector': 'independent',
        'why': 'Reports an image with no alt attribute at all as described. This is the failure '
               'that would make the tool actively harmful: it would tell a maintainer the page '
               'is fine when a screen reader user gets silence.',
    },
    {
        'name': 'reading-order-inversions-zeroed',
        'file': 'src/readingorder.js',
        'old': '      if (positions[i] > positions[j]) inversions += 1;',
        'new': '      if (false) inversions += 1;',
        'detector': 'tests',
        'why': 'Reports every document as perfectly ordered. A layout table that interleaves two '
               'stories then measures clean.',
    },
    {
        'name': 'layout-table-never-detected',
        'file': 'src/readingorder.js',
        'old': '  return !hasTh && !hasScope && !hasCaption && maxCols >= 2;',
        'new': '  return false;',
        'detector': 'tests',
        'why': 'Never recognises a layout table, so it is never unwrapped and the reading order '
               'defect survives remediation.',
    },
    {
        'name': 'columns-read-row-major',
        'file': 'src/readingorder.js',
        'old': '  for (let c = 0; c < cols; c += 1) {\n    for (const row of rows) {\n      if (row[c]) out.push(row[c]);\n    }\n  }',
        'new': '  for (const row of rows) {\n    for (let c = 0; c < cols; c += 1) {\n      if (row[c]) out.push(row[c]);\n    }\n  }',
        'detector': 'tests',
        'why': 'Unwraps a two column layout table in row order, which is the very interleaving '
               'the unwrapping exists to undo. The document still looks restructured.',
    },
    {
        'name': 'repair-target-lowered',
        'file': 'src/remediate.js',
        'old': 'export const REPAIR_TARGET = 4.5;',
        'new': 'export const REPAIR_TARGET = 3.0;',
        'detector': 'independent',
        'why': 'Repairs colours only to 3:1 while the tool goes on claiming 4.5:1. The output '
               'looks remediated and normal sized body text still fails WCAG AA.',
    },
    {
        'name': 'repair-accepts-any-candidate',
        'file': 'src/repair.js',
        'old': '    if (contrastRatio(cand, bg) >= target) {',
        'new': '    if (true) {',
        'detector': 'independent',
        'why': 'The bisection stops checking whether a candidate actually meets the target, so it '
               'converges on no movement at all and returns the original failing colour while '
               'reporting the repair as met.',
    },
    {
        'name': 'justification-left-in-place',
        'file': 'src/remediate.js',
        'old': "  text-align: left;\n  color: var(--lgb-ink);\n  background: var(--lgb-page);\n  margin: 0;",
        'new': "  text-align: justify;\n  color: var(--lgb-ink);\n  background: var(--lgb-page);\n  margin: 0;",
        'detector': 'independent',
        'why': 'Leaves the remediated document justified. Justified text creates rivers of white '
               'space, which is one of the specific things that makes a dense notice hard for a '
               'dyslexic reader to track.',
    },
    {
        'name': 'body-text-left-below-16px',
        'file': 'src/remediate.js',
        'old': '  const bodyPx = Math.max(MIN_BODY_PX, options.bodyPx || 19);',
        'new': '  const bodyPx = 11;',
        'detector': 'independent',
        'why': 'Sets the remediated body text to 11px. The colours still pass contrast, so a '
               'check that only looks at contrast reports a clean document nobody can read.',
    },
    {
        'name': 'text-silently-dropped',
        'file': 'src/remediate.js',
        'old': '      for (const child of cell.children.slice()) {\n        appendChild(section, child);\n      }',
        'new': '      for (const child of cell.children.slice(1)) {\n        appendChild(section, child);\n      }',
        'detector': 'tests',
        'why': 'Drops the first child of every unwrapped layout table cell. The output is still '
               'well formed and every contrast check still passes, and the reader has lost '
               'paragraphs of a legal notice.',
    },
    {
        'name': 'preservation-check-defanged',
        'file': 'src/remediate.js',
        'old': "  const ADDED = ['lgb-alt-flag', 'lgb-summary', 'lgb-skip'];",
        'new': "  const ADDED = ['lgb-alt-flag', 'lgb-summary', 'lgb-skip', 'lgb-column', 'lgb-shade', 'lgb-unwrapped'];",
        'detector': 'tests',
        'why': 'Strips the wrappers that hold the document\'s own words before comparing, so the '
               'preservation check passes by deleting the text it is supposed to be watching. '
               'The fingerprint barely moves; this is a check that stopped checking.',
    },
    {
        'name': 'stylesheet-at-rules-silently-skipped',
        'dormant': True,
        'file': 'src/css.js',
        'old': "      warnings.push(`at-rule not evaluated: ${prelude.split('{')[0].trim()}`);",
        'new': '      /* silently skipped */',
        'detector': 'tests',
        'why': 'Skips @media without saying so. Colours defined inside one are then measured as '
               'though they were never declared, and "could not check" reports as "checked".',
    },
    {
        'name': 'inline-style-loses-to-stylesheet',
        'file': 'src/css.js',
        'old': "  if (el.attrs && el.attrs.style) apply(parseDeclarations(el.attrs.style), 0, 0, true);",
        'new': "  if (false) apply(parseDeclarations(el.attrs.style), 0, 0, true);",
        'detector': 'tests',
        'why': 'Ignores inline style attributes, which is how most of these documents set their '
               'colours, and how the remediated output sets all of them.',
    },
    {
        'name': 'hidden-elements-measured',
        'dormant': True,
        'file': 'src/audit.js',
        'old': '    if (!st || st.hidden) return;',
        'new': '    if (!st) return;',
        'detector': 'tests',
        'why': 'Measures display:none text. Invisible content cannot fail contrast for a sighted '
               'reader, and counting it fills the report with findings nobody can act on.',
    },
    {
        'name': 'pdf-stream-order-trusted',
        'dormant': True,
        'file': 'src/pdf/extract.js',
        'old': '      const sorted = col.runs.slice().sort((a, b) => (Math.abs(b.y - a.y) > 0.5 ? b.y - a.y : a.x - b.x));\n      readingOrder.push(...sorted);',
        'new': '      readingOrder.push(...col.runs.slice());',
        'detector': 'tests',
        'why': 'Trusts the content stream order inside each column instead of sorting by position, '
               'which is what a naive PDF reader does and why two column notices come out '
               'interleaved.',
    },
    {
        'name': 'pdf-decode-failure-returns-empty',
        'dormant': True,
        'file': 'src/pdf/extract.js',
        'old': "    throw new Error(`unsupported stream filter ${filter} in object ${obj.num}`);",
        'new': '    return null;',
        'detector': 'tests',
        'why': 'Returns no text for a stream it cannot decode, which is indistinguishable from a '
               'page with no text on it. The audit then reports a clean document.',
    },
    {
        'name': 'summary-failure-becomes-empty-success',
        'dormant': True,
        'file': 'src/summary.js',
        'old': "    return { ok: false, error: `local model at ${endpoint} did not answer: ${err.message}` };",
        'new': "    return { ok: true, paragraphs: [], model, disclaimer: DISCLAIMER };",
        'detector': 'tests',
        'why': 'Turns "the model is not running" into a successful empty summary. This is the '
               'silent failure pattern: the caller cannot tell "checked, nothing to say" from '
               '"could not check".',
    },
    {
        'name': 'summary-disclaimer-removed',
        'dormant': True,
        'file': 'src/summary.js',
        'old': "export const DISCLAIMER = 'Written by a language model from the text below. It can be wrong. '\n  + 'The full original text follows and has not been changed.';",
        'new': "export const DISCLAIMER = 'Summary of this notice.';",
        'detector': 'tests',
        'why': 'Removes the note saying a machine wrote the summary and that it can be wrong. On '
               'a benefit notice that turns a reading aid into something that reads as official.',
    },
    {
        'name': 'extension-drifts-from-cli',
        'dormant': True,
        'file': 'extension/lib/legible-core.js',
        'old': '    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);',
        'new': '    return Math.pow(c, 2.2);',
        'detector': 'tests',
        'why': 'The extension and the CLI silently disagree about contrast. The CLI still passes '
               'everything, and the extension tells a reader a page is fine when it is not.',
    },
    {
        'name': 'docs-page-number-edited-by-hand',
        'dormant': True,
        'file': 'docs/index.html',
        'old': '<h1>legible-docs, measured</h1>',
        'new': '<h1>legible-docs, measured (hand edited)</h1>',
        'detector': 'docs',
        'why': 'The published page is edited directly rather than regenerated. Any hand edit '
               'means the page and the measurements behind it can drift apart.',
    },
]

# Guard sabotages. These remove code that is dormant when the input is correct, so the
# fingerprint does NOT move and gate 2 is inverted: unchanged output, failing unit suite.
GUARDS = [
    {
        'name': 'guard-pdf-no-pages',
        'file': 'src/pdf/extract.js',
        'old': "  if (pageObjs.length === 0) throw new Error('no page objects found, this file may not be a PDF this tool can read');",
        'new': '  /* guard removed */',
        'why': 'A file that is not a PDF would produce an empty result instead of an error. '
               'Dormant on the corpus, which is why the fingerprint must not move.',
    },
    {
        'name': 'guard-summary-rejects-empty-answer',
        'file': 'src/summary.js',
        'old': "  if (typeof answer !== 'string' || answer.trim() === '') {\n    return { ok: false, error: 'local model returned an empty answer' };\n  }",
        'new': '  /* guard removed */',
        'why': 'An empty model answer would be accepted as a summary. The summary is off by '
               'default, so no corpus measurement changes.',
    },
    {
        'name': 'guard-shade-band-gives-up',
        'file': 'src/repair.js',
        'old': "    if (bandRatio >= minBandContrast) break; // band is visible but text no longer passes on it",
        'new': '    /* guard removed */',
        'why': 'The band search would keep darkening past the point where the text stops passing '
               'on it. With #1a1a1a ink the first acceptable band is found before the guard is '
               'reached, so the corpus output is unchanged.',
    },
    {
        'name': 'guard-fingerprint-path-leak',
        'file': 'scripts/pathleak.js',
        'old': '  return best;',
        'new': '  return null;',
        'why': 'The fingerprint would stop refusing to emit output containing a filesystem path. '
               'Nothing leaks today, so the fingerprint itself is unchanged, and the guard that '
               'keeps this whole harness honest would be gone.',
    },
]


# ------------------------------------------------------------------------------------------
# Harness
# ------------------------------------------------------------------------------------------

class Result:
    def __init__(self, name, why, kind):
        self.name = name
        self.why = why
        self.kind = kind
        self.applied = False
        self.changed_output = None
        self.caught = False
        self.detector = ''
        self.note = ''

    @property
    def inverted(self):
        """True when gate 2 asks for an UNCHANGED fingerprint rather than a changed one."""
        return self.kind == 'dormant'

    @property
    def proven(self):
        if not self.applied:
            return False
        if self.inverted:
            return self.changed_output is False and self.caught
        return self.changed_output is True and self.caught


def copy_tree(dest):
    shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__'))


def fingerprint(tree):
    proc = subprocess.run([sys.executable and 'node', 'scripts/fingerprint.js'],
                          cwd=tree, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        return None, proc.stderr.strip()[:400]
    return hashlib.sha256(proc.stdout.encode()).hexdigest(), ''


def run_tests(tree):
    """The unit suite. Returns True when it passes."""
    proc = subprocess.run(['bash', '-lc', 'node --test --test-reporter=tap test/*.test.js'],
                          cwd=tree, capture_output=True, text=True, timeout=600)
    return proc.returncode == 0, proc.stdout[-1500:]


def run_independent(tree):
    """The CLI over the corpus, then the independent Python checker over what it produced."""
    work = os.path.join(tree, '.sabotage-work')
    os.makedirs(work, exist_ok=True)
    corpus = os.path.join(tree, 'corpus')
    for name in sorted(os.listdir(corpus)):
        if not name.lower().endswith(('.html', '.htm')):
            continue
        stem = os.path.splitext(name)[0]
        order = os.path.join('corpus', '%s.order.txt' % stem)
        order_args = ['--order', order] if os.path.exists(os.path.join(tree, order)) else []
        with open(os.path.join(work, '%s.before.json' % stem), 'w') as fh:
            subprocess.run(['node', 'bin/legible.js', 'audit', os.path.join('corpus', name),
                            *order_args, '--json'], cwd=tree, stdout=fh,
                           stderr=subprocess.DEVNULL, timeout=300)
        subprocess.run(['node', 'bin/legible.js', 'fix', os.path.join('corpus', name),
                        '--out', os.path.join(work, '%s.out.html' % stem), *order_args],
                       cwd=tree, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
        with open(os.path.join(work, '%s.after.json' % stem), 'w') as fh:
            subprocess.run(['node', 'bin/legible.js', 'audit',
                            os.path.join(work, '%s.out.html' % stem), *order_args, '--json'],
                           cwd=tree, stdout=fh, stderr=subprocess.DEVNULL, timeout=300)
    proc = subprocess.run([sys.executable, 'checks/check_independent.py',
                           '--corpus', 'corpus', '--work', work],
                          cwd=tree, capture_output=True, text=True, timeout=600)
    return proc.returncode == 0, proc.stdout[-1500:] + proc.stderr[-500:]


def run_docs(tree):
    proc = subprocess.run(['node', 'scripts/build-docs.js', '--check'],
                          cwd=tree, capture_output=True, text=True, timeout=300)
    return proc.returncode == 0, (proc.stdout + proc.stderr)[-600:]


DETECTORS = {'tests': ('unit suite', run_tests),
             'independent': ('independent checker', run_independent),
             'docs': ('docs page rebuild', run_docs)}


def apply_patch(tree, spec):
    path = os.path.join(tree, spec['file'])
    if not os.path.isfile(path):
        return False, 'file %s does not exist' % spec['file']
    with open(path, encoding='utf-8') as fh:
        before = fh.read()
    if spec['old'] not in before:
        return False, 'anchor not found in %s, the patch would have been a no-op' % spec['file']
    after = before.replace(spec['old'], spec['new'], 1)
    if after == before:
        return False, 'replacement produced an identical file'
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(after)
    return True, '%s: %d bytes -> %d bytes' % (spec['file'], len(before), len(after))


def null_control(baseline_hash):
    """An unchanged copy, in a different directory, must fingerprint identically."""
    with tempfile.TemporaryDirectory(prefix='legible-null-') as tmp:
        tree = os.path.join(tmp, 'copy')
        copy_tree(tree)
        got, err = fingerprint(tree)
        if got is None:
            return False, 'the copied tree could not be fingerprinted: %s' % err
        if got != baseline_hash:
            return False, ('the same code in a different directory fingerprints differently\n'
                           '    baseline %s\n    copy     %s' % (baseline_hash[:16], got[:16]))
        return True, 'unchanged copy fingerprints identically (%s)' % got[:16]


def run_one(spec, baseline_hash, kind):
    res = Result(spec['name'], spec['why'], kind)
    with tempfile.TemporaryDirectory(prefix='legible-sab-') as tmp:
        tree = os.path.join(tmp, 'copy')
        copy_tree(tree)

        applied, note = apply_patch(tree, spec)
        res.applied = applied
        res.note = note
        if not applied:
            return res

        got, err = fingerprint(tree)
        if got is None:
            # A fingerprint that cannot be produced at all IS a change in the measured output:
            # the tool crashed. That counts for gate 2, and it is recorded as such.
            res.changed_output = True
            res.note += ' | the tool no longer runs: %s' % err
        else:
            res.changed_output = (got != baseline_hash)

        detector_key = spec.get('detector', 'tests')
        label, fn = DETECTORS[detector_key]
        res.detector = label
        try:
            passed, _ = fn(tree)
        except subprocess.TimeoutExpired:
            passed = False
            res.note += ' | the detector timed out, which counts as caught'
        res.caught = not passed
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--check-anchors', action='store_true',
                    help='verify every patch anchor still matches its file, without running '
                         'anything. Cheap enough for verify.sh, which cannot afford the full run.')
    ap.add_argument('--only')
    args = ap.parse_args()

    everything = [(s, 'sabotage') for s in SABOTAGES] + [(s, 'guard') for s in GUARDS]
    everything = [(s, 'dormant' if (k == 'guard' or s.get('dormant')) else k) for s, k in everything]
    if args.list:
        for spec, kind in everything:
            print('%-42s %-8s %s' % (spec['name'], kind, spec['file']))
        return 0
    if args.check_anchors:
        # A sabotage whose anchor has rotted is a sabotage that will quietly become a no-op.
        # The full run catches that at gate 1, but it takes half an hour, so the anchors are
        # checked on their own every time verify runs.
        problems = []
        for spec, _ in everything:
            path = os.path.join(ROOT, spec['file'])
            if not os.path.isfile(path):
                problems.append('%s: %s does not exist' % (spec['name'], spec['file']))
                continue
            with open(path, encoding='utf-8') as fh:
                body = fh.read()
            found = body.count(spec['old'])
            if found == 0:
                problems.append('%s: anchor not found in %s, this sabotage would be a no-op'
                                % (spec['name'], spec['file']))
            elif found > 1:
                problems.append('%s: anchor appears %d times in %s, so the patch would be '
                                'ambiguous' % (spec['name'], found, spec['file']))
            elif spec['old'] == spec['new']:
                problems.append('%s: the patch replaces the anchor with itself' % spec['name'])
        print('anchor check: %d sabotage(s) across %d file(s)'
              % (len(everything), len({s['file'] for s, _ in everything})))
        if problems:
            print('ANCHOR CHECK FAILED: %d problem(s)' % len(problems))
            for p_ in problems:
                print('  %s' % p_)
            return 1
        print('ANCHOR CHECK PASSED: every sabotage still has exactly one live anchor')
        return 0

    if args.only:
        everything = [(s, k) for s, k in everything if s['name'] == args.only]
        if not everything:
            print('no sabotage named %r' % args.only)
            return 2

    print('sabotage harness for legible-docs')
    print('=' * 78)

    baseline_hash, err = fingerprint(ROOT)
    if baseline_hash is None:
        print('ABORTED: the unmodified tree could not be fingerprinted: %s' % err)
        return 2
    print('baseline fingerprint: %s' % baseline_hash[:16])

    print('\nNULL CONTROL (runs first, and the run is void if it fails)')
    ok, message = null_control(baseline_hash)
    print('  %s %s' % ('ok  ' if ok else 'FAIL', message))
    if not ok:
        print('\nABORTED. The fingerprint depends on where the tree lives rather than on what the')
        print('code does. Gate 2 would pass automatically for every sabotage below, so every')
        print('result would be meaningless. Nothing else was run.')
        return 2

    results = []
    for spec, kind in everything:
        print('\n%s  [%s, detector: %s]' % (spec['name'], kind, spec.get('detector', 'tests')))
        print('  %s' % spec['why'].replace('\n', '\n  '))
        res = run_one(spec, baseline_hash, kind)
        results.append(res)

        g1 = 'PASS' if res.applied else 'FAIL'
        print('  gate 1 applied ............ %s  %s' % (g1, res.note))
        if not res.applied:
            print('  gate 2 skipped, gate 3 skipped: an attack that did not apply proves nothing')
            print('  RESULT: HARNESS FAILURE, not a gap in the verify')
            continue

        if res.inverted:
            g2ok = res.changed_output is False
            print('  gate 2 output UNCHANGED ... %s  (a dormant guard must not move the measurement)'
                  % ('PASS' if g2ok else 'FAIL'))
        else:
            g2ok = res.changed_output is True
            print('  gate 2 output changed ..... %s' % ('PASS' if g2ok else 'FAIL'))
        if not g2ok:
            if res.inverted:
                print('  RESULT: HARNESS FAILURE. This is marked dormant but it moved the '
                      "measurement, so drop its 'dormant' flag and require gate 2 normally.")
            else:
                print('  RESULT: HARNESS FAILURE. The code changed but no measurement did, so the '
                      'patch reached dead code and this proves nothing about the checks.')

        print('  gate 3 caught by %-9s %s' % (res.detector, 'PASS' if res.caught else 'FAIL'))
        if res.proven:
            print('  RESULT: PROVEN')
        elif g2ok and not res.caught:
            print('  RESULT: NOT CAUGHT. This is a real gap in the checks.')

    print('\n' + '=' * 78)
    proven = [r for r in results if r.proven]
    harness_failures = [r for r in results if not r.applied
                        or (r.inverted and r.changed_output is not False)
                        or (not r.inverted and r.changed_output is not True)]
    gaps = [r for r in results if r not in harness_failures and not r.caught]

    print('%d of %d proven' % (len(proven), len(results)))
    if harness_failures:
        print('%d harness failure(s), where the attack itself did nothing:' % len(harness_failures))
        for r in harness_failures:
            print('  %s: %s' % (r.name, r.note))
    if gaps:
        print('%d real gap(s), where a working sabotage was not caught:' % len(gaps))
        for r in gaps:
            print('  %s (detector: %s)' % (r.name, r.detector))

    if harness_failures or gaps:
        print('SABOTAGE RUN FAILED')
        return 1
    print('SABOTAGE RUN PASSED: every sabotage applied, moved the measurement as expected, '
          'and was caught')
    return 0


if __name__ == '__main__':
    sys.exit(main())
