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

const providerModule =
  process.env.GENERATION_PROVIDER === 'fake' ? './providers/fake.mjs' : './providers/anthropic.mjs';
const { streamCompletion } = await import(providerModule);

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
    for await (const delta of streamCompletion({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      system,
      messages,
    })) {
      sse(res, { delta });
    }
    sse(res, { done: true });
  } catch (err) {
    sse(res, { error: String((err && err.message) || err) });
  }
  res.end();
});

server.listen(PORT, () => console.log(`generation proxy listening on :${PORT} (provider: ${providerModule})`));
