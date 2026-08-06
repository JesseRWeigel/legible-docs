// Optional plain language summary from a local model.
//
// Off unless asked for. It runs against a local Ollama endpoint, never a paid API, and the
// output is placed beside the original text with a visible note saying a model wrote it. The
// original wording is never edited or replaced, because these documents are legal notices and
// a summary that quietly became the document would be a worse accessibility problem than the
// one this project set out to fix.
//
// The transport is injectable so the prompt construction, the response handling, and the
// refusal to accept a useless answer can all be tested without a model and without a socket.

import { parseHTML, textContent, byTag, findAll, removeNode } from './html/parse.js';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/generate';
export const DEFAULT_MODEL = 'gemma4:e4b';
export const DISCLAIMER = 'Written by a language model from the text below. It can be wrong. '
  + 'The full original text follows and has not been changed.';

export function documentText(html, limit = 6000) {
  const root = parseHTML(html);
  for (const el of byTag(root, 'style')) removeNode(el);
  for (const el of byTag(root, 'script')) removeNode(el);
  for (const el of findAll(root, (n) => n.type === 'element' && (n.attrs.class || '').includes('lgb-'))) removeNode(el);
  return textContent(root).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim().slice(0, limit);
}

export function buildPrompt(text) {
  return [
    'Summarise this official document for an adult who finds dense text hard to read.',
    'Rules:',
    '1. Use short sentences and everyday words.',
    '2. Keep every date, amount, deadline, and phone number exactly as written.',
    '3. Do not add advice, opinions, or anything the document does not say.',
    '4. If the document says the reader must do something, say what and by when.',
    '5. Write three short paragraphs at most. Plain text only, no markdown.',
    '',
    'Document:',
    text
  ].join('\n');
}

async function httpTransport(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`endpoint returned HTTP ${res.status}`);
  return res.json();
}

/**
 * @returns {{ok: true, paragraphs: string[], model: string, disclaimer: string}
 *          | {ok: false, error: string}}
 * Failure is a value, never an empty summary that looks like a successful one.
 */
export async function summarize(html, options = {}) {
  const text = documentText(html);
  if (text.length < 40) return { ok: false, error: 'document has too little text to summarise' };
  const model = options.model || DEFAULT_MODEL;
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const transport = options.transport || httpTransport;
  const body = {
    model,
    prompt: buildPrompt(text),
    stream: false,
    think: false,
    options: { temperature: 0 }
  };
  let raw;
  try {
    raw = await transport(endpoint, body);
  } catch (err) {
    return { ok: false, error: `local model at ${endpoint} did not answer: ${err.message}` };
  }
  const answer = typeof raw === 'string' ? raw : (raw && (raw.response || raw.text));
  if (typeof answer !== 'string' || answer.trim() === '') {
    return { ok: false, error: 'local model returned an empty answer' };
  }
  const paragraphs = answer
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return { ok: false, error: 'local model returned no usable paragraphs' };
  return { ok: true, paragraphs, model, disclaimer: DISCLAIMER };
}
