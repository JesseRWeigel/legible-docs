#!/usr/bin/env bash
# The verify command for legible-docs. Its exit code is the result.
#
# Rules this script holds itself to:
#
#   - Nothing prints success for a step it did not run. Every step either runs and is judged,
#     or the whole script fails. There is no skip. A skipped check and a passing check are
#     indistinguishable in a log a week later, and the difference is exactly what matters.
#   - A missing dependency is a FAILURE with an actionable message, never a shrug.
#   - The last thing it does is read its own README, because a project can report thirty green
#     checks while its README still says "TODO: replace with a real description".
#
# Run it from anywhere: it resolves its own directory and works from the project root.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || exit 1

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
SUCCESS_LINE="ALL CHECKS PASSED"

step() { printf '\n=== %s\n' "$1"; }
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

# Run a command, print its output indented, and judge it by exit code.
judge() {
  local label="$1"; shift
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  printf '%s\n' "$out" | sed 's/^/  | /'
  if [ "$rc" -eq 0 ]; then ok "$label"; else bad "$label (exit $rc)"; fi
  return $rc
}

printf 'legible-docs verify\n'
printf 'root: %s\n' "$(basename "$ROOT")"

# ---------------------------------------------------------------------------------------
step "0. tools"
# ---------------------------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "node $(node --version)"
  else
    bad "node $(node --version) is too old, this project needs 18 or newer for node:test and fetch"
  fi
else
  bad "node is not installed. Install Node 18 or newer, then re-run. Without it nothing in this project can run at all."
fi
if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 -c 'import platform;print(platform.python_version())')"
else
  bad "python3 is not installed. Install Python 3.10 or newer. It runs the independent checker, the independence proof, the privacy scan and the sabotage harness, which together are four of the ten steps below."
fi
if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"; else bad "git is not installed, so the privacy scan cannot enumerate tracked files"; fi
# No dependencies at all beyond the runtimes, which is a claim worth checking rather than stating.
if [ -d node_modules ]; then
  bad "node_modules exists; this project is meant to have no dependencies"
else
  ok "no node_modules: stdlib only, nothing to install"
fi
if [ "$FAIL" -ne 0 ]; then
  printf '\nVERIFY FAILED: a required tool is missing, so the remaining steps were not run and nothing below is known.\n'
  exit 1
fi

# ---------------------------------------------------------------------------------------
step "1. unit suite"
# ---------------------------------------------------------------------------------------
TEST_OUT="$WORK/tests.txt"
# The TAP reporter is asked for explicitly. Node's default reporter writes its summary as
# "ℹ tests 130", and parsing that instead of TAP's "# tests 130" silently yields zero, which
# is how this step first reported a failing suite while every test passed.
node --test --test-reporter=tap test/*.test.js >"$TEST_OUT" 2>&1
TEST_RC=$?
TESTS=$(grep -E '^# tests '  "$TEST_OUT" | tail -1 | awk '{print $3}')
TPASS=$(grep -E '^# pass '   "$TEST_OUT" | tail -1 | awk '{print $3}')
TFAIL=$(grep -E '^# fail '   "$TEST_OUT" | tail -1 | awk '{print $3}')
TSKIP=$(grep -E '^# skipped ' "$TEST_OUT" | tail -1 | awk '{print $3}')
TODO=$(grep -E '^# todo '    "$TEST_OUT" | tail -1 | awk '{print $3}')
# Missing counters default to "bad". If the summary could not be parsed at all, that is a
# failure to measure, and a failure to measure is reported as a failure.
TESTS=${TESTS:-0}; TPASS=${TPASS:-0}; TFAIL=${TFAIL:-1}; TSKIP=${TSKIP:-0}; TODO=${TODO:-0}
printf '  | %s tests, %s passed, %s failed, %s skipped, %s todo\n' "$TESTS" "$TPASS" "$TFAIL" "$TSKIP" "$TODO"
if [ "$TEST_RC" -ne 0 ] || [ "$TFAIL" -ne 0 ]; then
  bad "unit suite (exit $TEST_RC, $TFAIL failing)"
  grep -E '^(not ok|✖|  AssertionError|  Error)' "$TEST_OUT" | head -30 | sed 's/^/  | /'
else
  ok "unit suite: $TPASS tests passed"
fi
# A suite that quietly shrinks is a suite that stopped checking things.
if [ "$TESTS" -lt 120 ]; then
  bad "only $TESTS tests ran, expected at least 120. Either tests were deleted or a file failed to load."
else
  ok "$TESTS tests ran, above the floor of 120"
fi
if [ "$TSKIP" -ne 0 ] || [ "$TODO" -ne 0 ]; then
  bad "$TSKIP skipped and $TODO todo tests. A skipped test reports the same green as a passing one."
else
  ok "no skipped and no todo tests"
fi

# ---------------------------------------------------------------------------------------
step "2. the command line tool runs, on every corpus document"
# ---------------------------------------------------------------------------------------
DOCS=0
for f in corpus/*.html corpus/*.pdf; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  stem="${base%.*}"
  ORDER=""
  [ -f "corpus/$stem.order.txt" ] && ORDER="--order corpus/$stem.order.txt"

  # shellcheck disable=SC2086
  if node bin/legible.js audit "$f" $ORDER --json >"$WORK/$stem.before.json" 2>"$WORK/$stem.audit.err"; then
    if [ -s "$WORK/$stem.before.json" ]; then ok "audit $base"; else bad "audit $base produced an empty report"; fi
  else
    bad "audit $base"; sed 's/^/  | /' "$WORK/$stem.audit.err"
  fi

  # `fix` asserts its own results and exits nonzero if the remediated document still fails, so
  # its exit code is a real check rather than a smoke test.
  # shellcheck disable=SC2086
  if node bin/legible.js fix "$f" --out "$WORK/$stem.out.html" $ORDER >"$WORK/$stem.fix.txt" 2>&1; then
    ok "fix $base (the tool's own assertions held)"
  else
    bad "fix $base"; tail -20 "$WORK/$stem.fix.txt" | sed 's/^/  | /'
  fi

  # shellcheck disable=SC2086
  if node bin/legible.js audit "$WORK/$stem.out.html" $ORDER --json >"$WORK/$stem.after.json" 2>&1; then
    ok "re-audit of the remediated $base"
  else
    bad "re-audit of the remediated $base"
  fi
  DOCS=$((DOCS + 1))
done
if [ "$DOCS" -lt 4 ]; then
  bad "only $DOCS corpus document(s) were processed, expected at least 4"
else
  ok "$DOCS corpus documents processed"
fi

# The PDF is a committed fixture. Regenerating it must reproduce it byte for byte, otherwise
# the fixture and the generator have drifted and the PDF tests are measuring history.
cp corpus/public-notice.pdf "$WORK/pdf-before.bin"
if node tools/make-pdf.js >/dev/null 2>&1; then
  if cmp -s "$WORK/pdf-before.bin" corpus/public-notice.pdf; then
    ok "corpus/public-notice.pdf regenerates byte for byte"
  else
    bad "regenerating corpus/public-notice.pdf produced different bytes; the fixture has drifted from tools/make-pdf.js"
    cp "$WORK/pdf-before.bin" corpus/public-notice.pdf
  fi
else
  bad "tools/make-pdf.js failed to run"
fi

# ---------------------------------------------------------------------------------------
step "3. the measurement is reproducible"
# ---------------------------------------------------------------------------------------
# The same null control that scripts/sabotage.py runs, run here too, because a fingerprint that
# tracks the working directory would make every sabotage look proven while proving nothing.
node scripts/fingerprint.js >"$WORK/fp-a.json" 2>"$WORK/fp.err"
FP_RC=$?
if [ "$FP_RC" -ne 0 ] || [ ! -s "$WORK/fp-a.json" ]; then
  bad "scripts/fingerprint.js did not produce a fingerprint"
  sed 's/^/  | /' "$WORK/fp.err"
else
  node scripts/fingerprint.js >"$WORK/fp-b.json" 2>&1
  if cmp -s "$WORK/fp-a.json" "$WORK/fp-b.json"; then
    ok "two runs in the same tree agree ($(wc -c <"$WORK/fp-a.json") bytes)"
  else
    bad "two runs in the same tree disagree, so the measurement is not deterministic"
  fi
  # And the same tree copied elsewhere has to fingerprint identically. If it does not, the
  # number depends on where the code lives rather than on what the code does.
  COPY="$WORK/nullcontrol"
  mkdir -p "$COPY"
  if tar -cf - --exclude=.git --exclude=node_modules . 2>/dev/null | tar -xf - -C "$COPY" 2>/dev/null; then
    if (cd "$COPY" && node scripts/fingerprint.js) >"$WORK/fp-c.json" 2>"$WORK/fp-c.err"; then
      if cmp -s "$WORK/fp-a.json" "$WORK/fp-c.json"; then
        ok "null control: an unchanged copy in a different directory fingerprints identically"
      else
        bad "null control: the same code in a different directory measures differently. The fingerprint is tracking the working directory, so no sabotage result can be trusted."
        diff <(head -c 4000 "$WORK/fp-a.json") <(head -c 4000 "$WORK/fp-c.json") | head -10 | sed 's/^/  | /'
      fi
    else
      bad "null control: the copied tree could not be fingerprinted"
      sed 's/^/  | /' "$WORK/fp-c.err"
    fi
  else
    bad "null control: could not copy the tree, so reproducibility was not established"
  fi
  if grep -qE '/home/|/tmp/|/Users/|file://' "$WORK/fp-a.json"; then
    bad "the fingerprint contains a filesystem path, which makes it track the checkout instead of the code"
  else
    ok "the fingerprint contains no filesystem paths"
  fi
fi

# ---------------------------------------------------------------------------------------
step "4. the independent checker imports nothing from the package under test"
# ---------------------------------------------------------------------------------------
judge "independence proof (ast import graph walk)" \
  python3 scripts/prove_independence.py \
    --entry checks/check_independent.py --project-root . \
    --package src --package bin --package extension --package tools

# ---------------------------------------------------------------------------------------
step "5. independent re-measurement"
# ---------------------------------------------------------------------------------------
judge "independent checker (second implementation, in Python)" \
  python3 checks/check_independent.py --corpus corpus --work "$WORK"

# ---------------------------------------------------------------------------------------
step "6. the published page is generated from the measurements, not hand written"
# ---------------------------------------------------------------------------------------
judge "docs/index.html matches what the current numbers build" \
  node scripts/build-docs.js --check

# ---------------------------------------------------------------------------------------
step "7. a real browser"
# ---------------------------------------------------------------------------------------
judge "browser check (published page and extension, measured inside Chrome)" \
  node scripts/browser_check.js

# ---------------------------------------------------------------------------------------
step "8. privacy"
# ---------------------------------------------------------------------------------------
judge "privacy scan with a positive control" python3 scripts/privacy_scan.py --root .

# ---------------------------------------------------------------------------------------
step "8b. the sabotage harness is still live"
# ---------------------------------------------------------------------------------------
# The full run takes around half an hour, which is too slow to put in front of every commit.
# What is checked here is that each of its patch anchors still matches exactly one place in the
# file it targets. An anchor that has rotted turns its sabotage into a no-op, and a no-op
# sabotage passes gate 1 by doing nothing, which is the exact failure the three-gate rule
# exists to catch. Run the whole thing with: python3 scripts/sabotage.py
judge "sabotage anchors all still match" python3 scripts/sabotage.py --check-anchors

# ---------------------------------------------------------------------------------------
step "9. the deploy workflow will not wedge"
# ---------------------------------------------------------------------------------------
WF=.github/workflows/pages.yml
if [ ! -f "$WF" ]; then
  bad "$WF is missing, so the published page has no way to deploy"
else
  if grep -qE 'group:[[:space:]]*pages-\$\{\{[[:space:]]*github\.run_id' "$WF"; then
    ok "pages workflow uses a per run concurrency group"
  else
    bad "pages workflow must use 'group: pages-\${{ github.run_id }}'. A shared 'group: pages' lets one wedged run hold the lock and every later deploy queues behind it forever."
  fi
  if grep -qE '^[[:space:]]*group:[[:space:]]*pages[[:space:]]*$' "$WF"; then
    bad "pages workflow still contains a bare 'group: pages'"
  else
    ok "no bare 'group: pages' anywhere in the workflow"
  fi
fi

# ---------------------------------------------------------------------------------------
step "10. the README describes the project that is actually here"
# ---------------------------------------------------------------------------------------
if [ ! -f README.md ]; then
  bad "README.md is missing"
else
  if grep -qiE 'TODO|FIXME|replace with a real description|NOT YET VERIFIED' README.md; then
    bad "README.md still contains a scaffold placeholder"
    grep -niE 'TODO|FIXME|replace with a real description|NOT YET VERIFIED' README.md | head -5 | sed 's/^/  | /'
  else
    ok "README.md has no scaffold placeholders left"
  fi
  if grep -q '^## Status' README.md; then ok "README.md has a Status section"; else bad "README.md has no ## Status section"; fi
  if grep -qF "$SUCCESS_LINE" README.md; then
    ok "README.md's Status section carries this script's success line"
  else
    bad "README.md does not contain the string '$SUCCESS_LINE', so its Status section is not pasted output of this script"
  fi
  # The test count in the README is a claim like any other, and it goes stale the moment
  # somebody adds a test.
  CLAIMED=$(grep -oE '^ok +[0-9]+ tests ran' README.md | head -1 | grep -oE '[0-9]+')
  if [ -n "${CLAIMED:-}" ]; then
    if [ "$CLAIMED" = "$TESTS" ]; then
      ok "the test count pasted in README.md ($CLAIMED) still matches the suite"
    else
      bad "README.md claims $CLAIMED tests, the suite just ran $TESTS. Re-paste the Status section."
    fi
  else
    bad "could not find a pasted test count in README.md to check against the $TESTS tests that just ran"
  fi
  if grep -qiE 'cannot|does not|limitation' README.md; then
    ok "README.md states what the tool cannot do"
  else
    bad "README.md never says what the tool cannot check, which for an accessibility tool is the important half"
  fi
fi

# ---------------------------------------------------------------------------------------
printf '\n===========================================\n'
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'VERIFY FAILED\n'
  exit 1
fi
printf '%s (%d checks)\n' "$SUCCESS_LINE" "$PASS"
exit 0
