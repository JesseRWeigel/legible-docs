#!/usr/bin/env bash
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
test_dir="$repo/tools/legible-browser-acceptance"
baseline=bf77fc79d20d5175b4e30daf28fad64efef5ea25
candidate=ef40527882beb8814b398f329b9c9509a5570906
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for spec in "base:$baseline" "candidate:$candidate"; do
  label=${spec%%:*}; sha=${spec#*:}
  [[ "$(git -C "$repo" rev-parse "$sha^{commit}")" == "$sha" ]]
  mkdir "$work/$label"
  git -C "$repo" archive "$sha" | tar -x -C "$work/$label"
  echo "$label $sha"
  node "$work/$label/bin/legible.js" fix "$test_dir/fixture.html" --out "$work/$label.html"
done
chrome=${CHROME_BIN:-$(command -v google-chrome || command -v chromium || true)}
driver=${CHROME_DRIVER:-${CHROMEWEBDRIVER:-}}
if [[ -d "$driver" ]]; then driver="$driver/chromedriver"; fi
if [[ -z "$driver" ]]; then driver=$(command -v chromedriver || true); fi
[[ -n "$chrome" && -x "$chrome" && -n "$driver" && -x "$driver" ]] ||
  { echo "Missing existing Chrome or ChromeDriver; no install, no sandbox fallback." >&2; exit 2; }
"$chrome" --version
"$driver" --version
python3 "$test_dir/probe.py" "$work/base.html" "$work/candidate.html" --driver "$driver" --chrome "$chrome"
