# legible-docs

A command line tool and a Chrome extension that reflow public notices, school letters, and
benefit forms for dyslexic and low vision readers, then report in numbers what they changed and
what they could not.

**[What it does to a document, measured →](https://jesserweigel.github.io/legible-docs/)**

Catalog task `CIVIC-044`, from a public catalog of build ideas:
https://github.com/JesseRWeigel/722-things-to-build

## The problem

The documents that decide whether someone keeps their benefits arrive as nine point grey text,
justified, in a layout table, with the important line set in bold rather than marked up as a
heading. They are hard to read for everybody and unusable for a lot of people. The fix is not
complicated, and it almost never gets done.

## What it does

It never removes or rewords the document's text. A benefit notice is a legal document, and the
wording is the thing being delivered. What changes is presentation:

- **Typeface.** Atkinson Hyperlegible or OpenDyslexic, whichever is installed. Neither is
  bundled and neither is downloaded, so the tool works offline.
- **Spacing.** WCAG 1.4.12 values as the authored default rather than as something the document
  merely tolerates: 1.5 line height, 0.12em tracking, 0.16em word spacing, 2em between
  paragraphs, and a measure capped at 66 characters.
- **Ragged right.** Justified text is turned off. Justification opens rivers of white space
  down a column, which is one of the specific things that makes tracking a line hard.
- **Paragraph shading.** Alternating bands, with the band colour chosen by measurement: far
  enough from the page to be visible, near enough that the text on it still passes contrast.
- **Colour.** Every text colour is moved until it reaches 4.5:1, including large text, which
  WCAG only asks to reach 3:1. Darkening scales the linear light channels by a single factor,
  which preserves the hue exactly, so a navy heading stays navy.
- **Structure.** Layout tables are unwrapped into column order, lines that were only styled to
  look like headings become real headings, a `<main>` landmark and a skip link are added, and
  the document gets a `lang`.
- **Alt text.** Images with no usable description are flagged in the page for a person to write.
  Nothing is invented.
- **An optional plain language summary** from a local model, placed alongside the original text
  and never over it, with a visible note saying a machine wrote it. Off by default.

## Running it

No dependencies. Node 18 or newer and Python 3.10 or newer, both from the standard library only.
The test workflow covers Node 18, 20, 22 and 24. Temporary JavaScript fixtures declare
ESM explicitly rather than relying on newer Node versions to infer their module type.

```bash
node bin/legible.js audit corpus/benefit-notice.html
node bin/legible.js audit corpus/benefit-notice.html --json
node bin/legible.js fix   corpus/benefit-notice.html --out readable.html --face atkinson
node bin/legible.js fix   corpus/public-notice.pdf   --out readable.html --face opendyslexic
node bin/legible.js pdf-text corpus/public-notice.pdf
```

`fix` checks preservation and contrast before publishing the result. A failed check leaves
an existing output unchanged and creates no final output. A passing candidate is written to
a temporary sibling and atomically renamed into place; write/rename errors return nonzero
and clean up staging files. The published file has owner-only permissions. This atomic
replacement does not promise durability across power loss or preserve destination metadata.

The plain language summary needs a local Ollama running, and is off unless asked for:

```bash
LEGIBLE_LLM_ENDPOINT=http://127.0.0.1:11434/api/generate \
  node bin/legible.js fix corpus/benefit-notice.html --out readable.html --summary --model gemma4:e4b
```

If the model does not answer, the document is not written at all. A partial run should not look
like a complete one.

### The extension

Load `extension/` in Chrome from *Manage extensions*, *Load unpacked*. It asks for `activeTab`
and `scripting` and nothing else, and it makes no network request of any kind. That is asserted
in the test suite rather than promised here, because a benefit notice is not something anybody
should be uploading to a server to have it made readable.

The extension has a real browser engine, so it takes every colour and size from
`getComputedStyle` rather than from the small CSS cascade the command line tool has to
implement. On the same document the two can disagree slightly, and where they do the extension
is the more accurate of the two.

## The measurements

**Contrast** is WCAG 2.1's: linearise each sRGB channel through the piecewise transfer function,
including the `0.03928` linear segment near black, weight the channels 0.2126, 0.7152 and
0.0722, then `(lighter + 0.05) / (darker + 0.05)`. The linearisation is the part that is easy to
drop and expensive to get wrong. Without it `#767676` on white reads 2.05:1 instead of 4.54:1,
which is the difference between failing a colour that passes and passing one that fails.

**The large text exception** is applied per run, not per document: 3:1 at 18pt or larger, or at
14pt or larger when bold, and 4.5:1 otherwise. The thresholds are converted from points exactly,
so 18pt is 24px and 14pt is 18.6667px. Several checkers round the bold threshold down to 18.66px,
which lets bold text at 13.995pt claim an allowance it has not earned.

**Reading order** is measured against a hand written ground truth. Each corpus document ships an
`.order.txt` listing its blocks in the order a person reads them aloud, and the metric is the
Kendall tau distance between that and the order the markup linearises in. Two stories side by
side in a layout table look right on screen and interleave in the DOM, and that disagreement is
the number.

**Alt text** is sorted into four outcomes rather than present or absent:

| Outcome | Meaning |
|---|---|
| `described` | Real alt text. Kept exactly as the author wrote it. |
| `declared-decorative` | `alt=""`, `role="presentation"` or `aria-hidden`. Correct markup, left alone. |
| `auto-decorative` | A spacer proved decorative by its pixel dimensions or a known spacer filename. |
| `needs-human` | No usable description. Flagged in the page. Nothing invented. |

An empty `alt` is the correct markup for a decorative image and a silent information loss on an
informative one. The attribute alone cannot tell the two apart, so it is read as the author's
declaration and never counted as a described image. A checker that flags every empty alt buries
its real findings under one false positive per divider rule on the page; a checker that accepts
any alt at all passes `alt="image"`.

## What this tool cannot check

For an accessibility tool this is the important half, because a wrong pass harms exactly the
people it claims to serve.

- **It cannot see an image.** No alt text is ever generated. An image with no usable description
  is flagged for a person, and the missing alt is left missing so every other checker still
  reports it.
- **It cannot read a scanned PDF.** A page with no text layer is reported as needing optical
  character recognition. No text is invented for it.
- **It does not fetch external stylesheets.** A colour that lives in a linked CSS file is
  reported as unmeasured, with a warning naming the file.
- **It does not evaluate at-rules.** Colours inside `@media` or `@supports` are skipped and
  warned about rather than guessed at.
- **The command line tool has no browser.** Its CSS cascade covers type, class, id, descendant
  and child selectors, comma groups, specificity, `!important`, inline styles, and the old
  presentational attributes. It does not do JavaScript, custom properties beyond simple
  substitution, pseudo-classes, flexbox, grid, or any layout at all. Reading order is measured
  from the markup and from a hand written ground truth, never from where boxes actually land.
- **The PDF reader is small.** Uncompressed and FlateDecode content streams, the standard 14
  fonts, single byte text. No CID fonts, no embedded subset encodings, no tagged structure trees.
- **`legible fix` writes HTML, never PDF.** A PDF goes in, an HTML document comes out.
- **It cannot tell you whether the writing is any good.** Contrast, spacing and order are
  measurable. Whether a benefit notice makes sense to the person who received it is not, and
  nothing here should be read as saying it does.
- **The plain language summary is machine written and can be wrong.** It is off by default, it
  runs against a local model and never a hosted API, it is placed beside the original, and it
  says so in the page.
- **Repaired colours land just above the target, not at maximum contrast.** The repair preserves
  hue, so grey body text becomes darker grey rather than black. That is deliberate, because
  colour can carry meaning, but it means a remediated document sits near 4.5:1 rather than far
  above it.

## How it is verified

```bash
bash scripts/verify.sh          # the whole thing, exit code is the result
python3 scripts/sabotage.py     # break it on purpose, ~30 minutes
```

`verify.sh` has no skips. A step that cannot run is a failure, because a skipped check and a
passing check are indistinguishable in a log a week later.

- **A second implementation.** `checks/check_independent.py` reimplements the sRGB contrast maths
  and a small CSS cascade in Python and measures the same documents again. It imports nothing
  from the package under test, which `scripts/prove_independence.py` proves by walking its import
  graph with `ast` rather than by grepping, and by failing on `subprocess`, `importlib`,
  `__import__`, `eval` and any string that names a file in the package. It checks its own
  arithmetic against three ratios computed by hand before it judges anything.
- **35 sabotages under a three-gate rule.** Each one has to apply, change the measured output,
  and only then be caught. A sabotage that applies and changes nothing is reported as a harness
  failure, never as a pass. A null control runs first: an unchanged copy of the tree in a
  different directory must fingerprint identically, and the run aborts if it does not.
- **A privacy scan with a positive control.** A credential is planted where the scanner will read
  it and the run fails if it is not found. It reads bytes rather than lines, so a NUL byte in the
  PDF fixture cannot make it skip a file, and it fails if too few files are tracked, because
  before the first commit `git ls-files` is empty and the scan passes without opening anything.
- **A real browser.** Chrome loads the published page and the extension's own content script and
  measures inside them. This is what catches an inline script that fails to parse, and it is what
  caught the extension leaving author `font-size` rules applying to descendants, so five runs
  stayed under 16px on a page the stylesheet claimed to have fixed.
- **The published page is generated** from `scripts/fingerprint.js` by `scripts/build-docs.js`,
  and verify rebuilds it and fails if it differs from the committed copy.

## Status

2026-11-13: the CLI output-publication fix passes the unit suite and all four
corpus audit/fix/re-audit flows, including independent measurement and privacy
checks. The full verification run exits 1: 36 checks passed, but the browser check
could not launch Chromium in the restricted runner (socket creation denied).
Browser/extension verification is **not** claimed for this revision.

```text
  ok   146 tests ran, above the floor of 120
```

The following is the historical 2026-08-06 verification record, not a new run:

Verified on 2026-08-06. `bash scripts/verify.sh`, exit code 0:

```
legible-docs verify
root: legible-docs

=== 0. tools
  ok   node v24.13.0
  ok   python3 3.12.3
  ok   git 2.43.0
  ok   no node_modules: stdlib only, nothing to install

=== 1. unit suite
  | 138 tests, 138 passed, 0 failed, 0 skipped, 0 todo
  ok   unit suite: 138 tests passed
  ok   138 tests ran, above the floor of 120
  ok   no skipped and no todo tests

=== 2. the command line tool runs, on every corpus document
  ok   audit accessible-control.html
  ok   fix accessible-control.html (the tool's own assertions held)
  ok   re-audit of the remediated accessible-control.html
  ok   audit benefit-notice.html
  ok   fix benefit-notice.html (the tool's own assertions held)
  ok   re-audit of the remediated benefit-notice.html
  ok   audit school-letter.html
  ok   fix school-letter.html (the tool's own assertions held)
  ok   re-audit of the remediated school-letter.html
  ok   audit public-notice.pdf
  ok   fix public-notice.pdf (the tool's own assertions held)
  ok   re-audit of the remediated public-notice.pdf
  ok   4 corpus documents processed
  ok   corpus/public-notice.pdf regenerates byte for byte

=== 3. the measurement is reproducible
  ok   two runs in the same tree agree (37806 bytes)
  ok   null control: an unchanged copy in a different directory fingerprints identically
  ok   the fingerprint contains no filesystem paths

=== 4. the independent checker imports nothing from the package under test
  | independence proof: walked 1 file(s), 6863 syntax nodes, from checks/check_independent.py
  |   parsed checks/check_independent.py
  | INDEPENDENCE PROOF PASSED: every import resolves to the Python standard library, and nothing in the graph can load or run the package under test
  ok   independence proof (ast import graph walk)

=== 5. independent re-measurement
  | independent check: 549 assertions over 3 documents
  | INDEPENDENT CHECK PASSED: all 549 assertions held
  ok   independent checker (second implementation, in Python)

=== 6. the published page is generated from the measurements, not hand written
  | docs/index.html matches the current measurements (22698 bytes)
  ok   docs/index.html matches what the current numbers build

=== 7. a real browser
  | browser check: using /usr/bin/google-chrome
  |   published page: inline script ran, 15 ratios recomputed in Chrome, 0 mismatched
  |   published page: no sideways overflow at 1280px, scrollWidth 1265
  |   extension in Chrome: 12 failing runs and 21 order inversions before, 0 and 0 after; 5 paragraphs shaded, 1 image flagged; revert restored the original
  | BROWSER CHECK PASSED
  ok   browser check (published page and extension, measured inside Chrome)

=== 8. privacy
  | privacy scan: 47 tracked file(s), 47 read, 306349 bytes, 1 containing a NUL byte read anyway
  |   skipped as binary by extension: 0 (none)
  |   positive control detected: AWS access key id, GitHub personal access token, absolute home directory path, assigned secret literal
  | PRIVACY SCAN PASSED: no credential-shaped strings and no personal paths in 47 files
  ok   privacy scan with a positive control

=== 8b. the sabotage harness is still live
  | anchor check: 35 sabotage(s) across 12 file(s)
  | ANCHOR CHECK PASSED: every sabotage still has exactly one live anchor
  ok   sabotage anchors all still match

=== 9. the deploy workflow will not wedge
  ok   pages workflow uses a per run concurrency group
  ok   no bare 'group: pages' anywhere in the workflow

=== 10. the README describes the project that is actually here
  ok   README.md has no scaffold placeholders left
  ok   README.md has a Status section
  ok   README.md's Status section carries this script's success line
  ok   the test count pasted in README.md (138) still matches the suite
  ok   README.md states what the tool cannot do

===========================================
41 passed, 0 failed
ALL CHECKS PASSED (41 checks)
```

`python3 scripts/sabotage.py`, exit code 0:

```
==============================================================================
35 of 35 proven
SABOTAGE RUN PASSED: every sabotage applied, moved the measurement as expected, and was caught
```

## Unfinished

- **`fix` cannot write a PDF back out.** A remediated PDF becomes an HTML document. Producing a
  tagged, reflowed PDF would need a writer this does not have.
- **No OCR.** A scanned notice is detected and reported, and that is as far as it goes.
- **The CSS cascade is a subset**, listed above. A document whose colours come from an external
  stylesheet or a `@media` block is reported as partly unmeasured rather than measured wrong,
  which is the right failure but is still a gap.
- **The extension has been driven headless, not clicked.** `scripts/browser_check.js` loads the
  real content script into a real page and calls the functions the popup calls, and the popup's
  own click handlers have not been exercised by a human or by a driver.
- **Reading order in the command line tool is measured against a hand written ground truth**, so
  it only works for documents that have one. The extension measures it from real box positions
  and needs no ground truth, which is the better approach and is not available without a browser.
- **Only one PDF fixture.** It covers two columns, no tagged structure and no `/Lang`. Encrypted
  PDFs, CID fonts and multi page documents are untested.

## Licence

MIT.
