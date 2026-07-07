#!/usr/bin/env node
// Small hosted-generation proxy (doc/plan.md §6/§8): the only place that
// holds the LLM provider API key. Builds the full prompt server-side
// (proxy/prompts.mjs) so the client can never override the system prompt
// (§13's "no system-prompt override" mitigation), then passes the
// provider's token stream through to the browser as a small normalized SSE
// format the client already knows how to read
// (src/host/generation-client.js): `data: {"delta":"..."}` per chunk,
// `data: {"done":true}` once at the end, or `data: {"error":"..."}` on
// failure. Provider-agnostic: proxy/providers/*.mjs all export the same
// `streamCompletion({apiKey, model, system, messages}) -> AsyncGenerator<string>`
// shape, so swapping providers (or using the fake one for tests, see
// providers/fake.mjs) never touches this file's request handling.
import { createServer } from 'node:http';
import { buildMessages } from './prompts.mjs';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_DESCRIPTION_LEN = 500;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

// Provider-agnostic: each entry's api key env var and default model line up
// with a proxy/providers/*.mjs module of the same streamCompletion shape.
// GENERATION_MODEL overrides the default model for whichever provider is
// selected; the per-provider api key env var is the one that provider's
// docs use (ANTHROPIC_API_KEY, TOGETHER_API_KEY), so swapping providers is
// just changing GENERATION_PROVIDER + that provider's key, no code change.
const PROVIDERS = {
  anthropic: { module: './providers/anthropic.mjs', apiKey: process.env.ANTHROPIC_API_KEY, defaultModel: 'claude-sonnet-5' },
  // Real-world finding: general instruction-tuned models were imprecise
  // about which closing bracket *type* (not count) ends a long run of
  // nested closers at the end of a calculator form -- a code-specialized
  // model is a better fit for this exact-bracket-matching-heavy task.
  // Qwen/Qwen2.5-Coder-32B-Instruct (tried first) turned out not to be on
  // Together's serverless tier; Kimi K2.7 Code is.
  together: { module: './providers/together.mjs', apiKey: process.env.TOGETHER_API_KEY, defaultModel: 'moonshotai/Kimi-K2.7-Code' },
  fake: { module: './providers/fake.mjs', apiKey: null, defaultModel: null },
};
const providerName = process.env.GENERATION_PROVIDER || 'anthropic';
const provider = PROVIDERS[providerName];
if (!provider) throw new Error(`unknown GENERATION_PROVIDER: ${providerName} (expected one of ${Object.keys(PROVIDERS).join(', ')})`);
const { streamCompletion } = await import(provider.module);
const model = process.env.GENERATION_MODEL || provider.defaultModel;

// Best-effort per-IP rate limiting (doc/plan.md §13): in-memory, so it
// resets on restart / doesn't share state across serverless instances --
// a real deployment behind multiple instances needs a shared store, noted
// as a nice-to-have in the plan's risk table, not a blocker for this size
// of proxy.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/generate') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limit exceeded, try again later' }));
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }

  const description = typeof body.description === 'string' ? body.description.slice(0, MAX_DESCRIPTION_LEN) : '';
  const attempt = Number.isInteger(body.attempt) && body.attempt > 0 ? body.attempt : 1;
  const priorSource = typeof body.priorSource === 'string' ? body.priorSource : null;
  const priorError = typeof body.priorError === 'string' ? body.priorError : null;

  if (!description) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'description is required' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  try {
    const { system, messages } = buildMessages({ description, attempt, priorSource, priorError });
    for await (const delta of streamCompletion({ apiKey: provider.apiKey, model, system, messages })) {
      sse(res, { delta });
    }
    sse(res, { done: true });
  } catch (err) {
    sse(res, { error: String((err && err.message) || err) });
  }
  res.end();
});

server.listen(PORT, () => console.log(`generation proxy listening on :${PORT} (provider: ${providerName}, model: ${model})`));
