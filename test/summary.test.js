import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, buildPrompt, documentText, DISCLAIMER, DEFAULT_MODEL } from '../src/summary.js';

const DOC = `<html><head><style>p{color:red}</style></head><body>
<p>Your household benefit amount changes on the first day of next month. The new monthly
amount is 412 dollars. You must reply by 14 March if you disagree.</p>
<p class="lgb-summary">A summary this tool added on an earlier run.</p>
</body></html>`;

const reply = (text) => async () => ({ response: text });

test('the document text handed to the model is the visible text only', () => {
  const text = documentText(DOC);
  assert.match(text, /Your household benefit amount changes/);
  assert.doesNotMatch(text, /color:red/, 'stylesheet source must not reach the model');
  assert.doesNotMatch(text, /A summary this tool added/, 'a previous run of this tool must not be re-summarised');
});

test('the prompt tells the model to keep the numbers and invent nothing', () => {
  const p = buildPrompt('Pay 412 dollars by 14 March.');
  assert.match(p, /Keep every date, amount, deadline, and phone number exactly as written/);
  assert.match(p, /Do not add advice, opinions, or anything the document does not say/);
  assert.match(p, /Pay 412 dollars by 14 March\./, 'the document text has to be in the prompt');
});

test('a successful summary comes back with paragraphs and a visible disclaimer', () => {
  return summarize(DOC, { transport: reply('Your benefit goes down next month.\n\nYou can ask for a hearing.') })
    .then((r) => {
      assert.equal(r.ok, true);
      assert.deepEqual(r.paragraphs, ['Your benefit goes down next month.', 'You can ask for a hearing.']);
      assert.equal(r.disclaimer, DISCLAIMER);
      assert.match(r.disclaimer, /can be wrong/);
      assert.match(r.disclaimer, /has not been changed/);
      assert.equal(r.model, DEFAULT_MODEL);
    });
});

test('a model that is not running is a failure value, not an empty summary', async () => {
  // The failure mode this guards against: returning {paragraphs: []} on a connection error,
  // which downstream renders as a document with an empty summary box and no sign anything
  // went wrong.
  const r = await summarize(DOC, {
    transport: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); }
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not answer/);
  assert.match(r.error, /ECONNREFUSED/, 'the real cause must survive into the message');
  assert.equal(r.paragraphs, undefined);
});

test('an empty or unusable answer is rejected', async () => {
  for (const bad of ['', '   ', '\n\n']) {
    const r = await summarize(DOC, { transport: reply(bad) });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should be rejected`);
  }
  const noField = await summarize(DOC, { transport: async () => ({ unexpected: 'shape' }) });
  assert.equal(noField.ok, false);
  assert.match(noField.error, /empty answer/);
});

test('a document with almost no text is not sent to a model at all', async () => {
  let called = false;
  const r = await summarize('<p>Hi.</p>', { transport: async () => { called = true; return { response: 'x' }; } });
  assert.equal(r.ok, false);
  assert.match(r.error, /too little text/);
  assert.equal(called, false);
});

test('the request is local, deterministic, and does not ask a thinking model to think', async () => {
  let seen = null;
  await summarize(DOC, {
    transport: async (endpoint, body) => { seen = { endpoint, body }; return { response: 'ok text here' }; }
  });
  assert.match(seen.endpoint, /^http:\/\/127\.0\.0\.1:11434\//, 'the default endpoint must be the local machine');
  assert.equal(seen.body.stream, false);
  assert.equal(seen.body.think, false);
  assert.equal(seen.body.options.temperature, 0);
});

test('the endpoint and model can be overridden', async () => {
  let seen = null;
  await summarize(DOC, {
    endpoint: 'http://127.0.0.1:9999/api/generate',
    model: 'qwen3-coder:30b',
    transport: async (endpoint, body) => { seen = { endpoint, body }; return { response: 'ok text here' }; }
  });
  assert.equal(seen.endpoint, 'http://127.0.0.1:9999/api/generate');
  assert.equal(seen.body.model, 'qwen3-coder:30b');
});
