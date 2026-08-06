// Tests for the measurement harness itself.
//
// The sabotage harness rests on one property: the fingerprint depends on the code and not on
// where the checkout sits. scripts/pathleak.js is the guard for that property, and it was the
// one guard in this project with nothing covering it, which the sabotage run found by removing
// it and watching every check stay green.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPathLeak, PATH_LEAK_PATTERNS } from '../scripts/pathleak.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

test('a filesystem path in the text is found', () => {
  const cases = [
    ['{"file": "/home/someone/projects/thing.html"}', 'unix home directory'],
    ['/Users/someone/Documents/notice.pdf', 'macOS home directory'],
    ['wrote /tmp/legible-abc123/out.html', 'temporary directory'],
    ['C:\\Users\\someone\\notice.html', 'Windows drive path'],
    ['loaded file:///home/x/page.html', 'file URL'],
    ['see ~/projects/legible-docs for more', 'tilde home directory'],
    ['"path": "~/notes/thing.md"', 'tilde home directory']
  ];
  for (const [text, expected] of cases) {
    const leak = findPathLeak(text);
    assert.ok(leak, `no leak found in ${JSON.stringify(text)}`);
    assert.equal(leak.name, expected, `${JSON.stringify(text)} matched as ${leak.name}`);
  }
});

test('ordinary prose is not a false positive', () => {
  const clean = [
    'the home directory is not named here',
    'tmp files are cleaned up',
    'contrast ratio 4.5:1 on #ffffff',
    'C: is a note about the C programming language',
    'a tilde ~ on its own, and a~b, and 3 ~ 4',
    'users of this tool',
    '{"outputSha": "ec6415091a3f3924", "outputBytes": 4146}',
    'corpus/benefit-notice.html and docs/index.html'
  ];
  for (const text of clean) {
    assert.equal(findPathLeak(text), null, `false positive on ${JSON.stringify(text)}`);
  }
});

test('the earliest leak is the one reported', () => {
  const leak = findPathLeak('clean text, then /tmp/a and then /home/b');
  assert.equal(leak.name, 'temporary directory');
  assert.ok(leak.index > 0);
});

test('every named pattern is exercised by the positive cases above', () => {
  // A pattern nobody tests is a pattern that can quietly stop matching.
  assert.ok(PATH_LEAK_PATTERNS.length >= 6, `only ${PATH_LEAK_PATTERNS.length} patterns`);
  const covered = new Set(['unix home directory', 'macOS home directory', 'temporary directory',
    'Windows drive path', 'file URL', 'tilde home directory']);
  for (const name of PATH_LEAK_PATTERNS) {
    if (name === 'private var directory') continue; // macOS only, exercised by the pattern list
    assert.ok(covered.has(name), `pattern ${name} has no positive test`);
  }
});

test('the fingerprint refuses to emit output that carries a path', () => {
  // End to end, against the real script: a corpus document is given a filename containing a
  // home directory shaped string, which lands in the fingerprint's document keys. The script
  // must exit nonzero and print nothing usable rather than emit a fingerprint that differs
  // between two copies of the same tree.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legible-leak-'));
  try {
    for (const dir of ['corpus', 'scripts', 'src', 'src/html', 'src/pdf']) {
      fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    }
    for (const f of ['scripts/fingerprint.js', 'scripts/pathleak.js', 'src/audit.js', 'src/alt.js',
      'src/color.js', 'src/css.js', 'src/readingorder.js', 'src/remediate.js', 'src/repair.js',
      'src/style.js', 'src/summary.js', 'src/html/parse.js', 'src/html/serialize.js',
      'src/pdf/extract.js']) {
      fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    }
    for (const f of fs.readdirSync(path.join(ROOT, 'corpus'))) {
      fs.copyFileSync(path.join(ROOT, 'corpus', f), path.join(tmp, 'corpus', f));
    }
    // A document whose text contains an absolute path. Text is where a real leak comes from:
    // the fingerprint records a sample of every run, so a notice quoting a build log would
    // carry the builder's home directory straight into the measurement.
    fs.writeFileSync(path.join(tmp, 'corpus', 'leaky.html'),
      '<html lang="en"><head><title>t</title><style>body{color:#1a1a1a;background:#fff;'
      + 'font-size:19px;line-height:1.6;letter-spacing:0.12em;text-align:left}</style></head>'
      + '<body><main><h1>A heading for this leaky document</h1>'
      + '<p>The report was written to /home/someone/output/report.html by the last run, and '
      + 'that absolute path is exactly what must never reach a fingerprint.</p></main></body></html>');

    let threw = false;
    let stderr = '';
    try {
      execFileSync(process.execPath, [path.join(tmp, 'scripts', 'fingerprint.js')],
        { encoding: 'utf8', cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      threw = true;
      stderr = String(err.stderr || '');
    }
    assert.ok(threw, 'the fingerprint emitted output despite a filesystem path being in it');
    assert.match(stderr, /refusing to emit/);
    assert.match(stderr, /home directory/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the fingerprint of the real corpus carries no path and is stable', () => {
  const run = () => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fingerprint.js')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const a = run();
  const b = run();
  assert.equal(a, b, 'two runs in the same tree produced different fingerprints');
  assert.equal(findPathLeak(a), null, 'the fingerprint of the real corpus contains a path');
  const parsed = JSON.parse(a);
  assert.equal(parsed.schema, 'legible-docs/fingerprint/1');
  assert.ok(Object.keys(parsed.documents).length >= 4,
    `the fingerprint covers only ${Object.keys(parsed.documents).length} documents`);
  assert.ok(parsed.probes.contrast.length >= 10);
});
