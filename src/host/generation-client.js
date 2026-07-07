// Streams a calculator generation request from the hosted proxy (doc/plan.md
// §6/§8/proxy/server.mjs). This is genuinely JS-only work -- fetch and SSE
// parsing don't exist inside a Repl (§7) -- so it's called from main.js's
// effect loop, not from Clojurust. Reports partial text back to the caller
// as it streams (throttled, since the "dimmed source scrolling by" UX only
// needs to look live, not reflect every byte) -- main.js writes this
// straight to the DOM rather than through the Repl (see its comment on
// runGenerateEffect) -- and resolves once with the full text or an error,
// which main.js reports to app.core as a single "generate-done"/
// "generate-error" handle-effect-result! call.
const TOKEN_REPORT_INTERVAL_MS = 80;

export async function streamGenerate({ description, attempt, priorSource, priorError }, onToken) {
  const endpoint = (typeof window !== 'undefined' && window.GENERATE_ENDPOINT) || '/api/generate';
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description, attempt, priorSource: priorSource ?? null, priorError: priorError ?? null }),
    });
  } catch (err) {
    return { ok: false, error: `could not reach the generation service: ${err.message}` };
  }
  if (!resp.ok || !resp.body) {
    let detail = '';
    try {
      detail = (await resp.json()).error || '';
    } catch {
      // ignore -- non-JSON error body
    }
    return { ok: false, error: `generation service returned ${resp.status}${detail ? `: ${detail}` : ''}` };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let lastReport = 0;
  let streamError = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let msg;
      try {
        msg = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (typeof msg.delta === 'string') {
        text += msg.delta;
        const now = Date.now();
        if (now - lastReport > TOKEN_REPORT_INTERVAL_MS) {
          lastReport = now;
          await onToken(text);
        }
      } else if (msg.error) {
        streamError = msg.error;
      }
    }
  }

  if (streamError) return { ok: false, error: streamError };
  await onToken(text);
  return { ok: true, text };
}
