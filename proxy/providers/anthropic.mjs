// Anthropic Messages API streaming client (doc/plan.md §8 hosted backend).
// Yields plain text deltas from the SSE stream; the proxy server normalizes
// those into its own small SSE format for the browser
// (src/host/generation-client.js), so swapping providers never touches
// proxy/server.mjs -- see proxy/providers/fake.mjs for the other
// implementation of this same generator interface.
export async function* streamCompletion({ apiKey, model, system, messages }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured on the proxy');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 2000, system, messages, stream: true }),
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Anthropic API returned ${resp.status}: ${text.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
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
      let evt;
      try {
        evt = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        yield evt.delta.text;
      } else if (evt.type === 'error') {
        throw new Error(evt.error?.message || 'Anthropic stream error');
      }
    }
  }
}
