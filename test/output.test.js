import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeOutputAtomic } from '../src/write-output.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legible-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(rootDir, input, output) {
  return spawnSync(process.execPath, [path.join(rootDir, 'bin/legible.js'), 'fix', input, '--out', output], { encoding: 'utf8' });
}

test('atomic publisher replaces an existing file only with a complete candidate', t => {
  const dir = workspace(t), out = path.join(dir, 'out.html');
  fs.writeFileSync(out, 'previous');
  writeOutputAtomic(out, 'validated');
  assert.equal(fs.readFileSync(out, 'utf8'), 'validated');
  assert.deepEqual(fs.readdirSync(dir), ['out.html']);
});

for (const operation of ['writeFileSync', 'renameSync']) {
  test(`failed ${operation} preserves prior output and removes staging`, t => {
    const dir = workspace(t), out = path.join(dir, 'out.html');
    fs.writeFileSync(out, 'previous');
    const io = { ...fs, [operation]() { throw new Error('injected filesystem failure'); } };
    assert.throws(() => writeOutputAtomic(out, 'candidate', io), /filesystem failure/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'previous');
    assert.deepEqual(fs.readdirSync(dir), ['out.html']);
  });
}

test('CLI publishes an audited real document and supports in-place remediation', t => {
  const dir = workspace(t), out = path.join(dir, 'out.html');
  fs.copyFileSync(path.join(root, 'corpus/benefit-notice.html'), out);
  const result = run(root, out, out);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /validated document written/);
  assert.match(fs.readFileSync(out, 'utf8'), /Atkinson/);
  assert.deepEqual(fs.readdirSync(dir), ['out.html']);
});

// Fault-inject into an isolated copy, not the production CLI, to exercise each
// validation refusal even when today's remediation succeeds on the corpus.
for (const failure of ['preservation', 'contrast', 'target']) {
  test(`CLI ${failure} failure never publishes or replaces output`, t => {
    const dir = workspace(t), copy = path.join(dir, 'app');
    fs.mkdirSync(copy);
    for (const name of ['src', 'bin']) fs.cpSync(path.join(root, name), path.join(copy, name), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
    const cli = path.join(copy, 'bin/legible.js');
    const injection = failure === 'preservation'
      ? 'preserved.preserved = false; preserved.missing = ["fixture"];'
      : failure === 'contrast' ? 'result.after.summary.failingContrast = 1;'
        : 'result.after.summary.minContrast = 1;';
    const source = fs.readFileSync(cli, 'utf8');
    assert.ok(source.includes('  printAudit(`before:'));
    fs.writeFileSync(cli, source.replace('  printAudit(`before:', `  ${injection}\n  printAudit(\`before:`));
    const input = path.join(root, 'corpus/benefit-notice.html');
    const out = path.join(dir, 'output.html');
    let result = run(copy, input, out);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(out), false);
    fs.writeFileSync(out, 'keep this exact text');
    result = run(copy, input, out);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), 'keep this exact text');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['app', 'output.html']);
  });
}

test('CLI reports a rename failure without leaving staging artifacts', t => {
  const dir = workspace(t), out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'keep'), 'untouched');
  const result = run(root, path.join(root, 'corpus/benefit-notice.html'), out);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error:/);
  assert.equal(fs.readFileSync(path.join(out, 'keep'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(dir), ['out']);
});
