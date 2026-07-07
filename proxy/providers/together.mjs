// Together AI streaming client (doc/plan.md §8 hosted backend) -- their
// Chat Completions API is OpenAI-compatible, so unlike Anthropic's Messages
// API the system prompt is just the first message with role "system"
// rather than a separate top-level field. Same
// `streamCompletion({apiKey, model, system, messages}) -> AsyncGenerator<string>`
// shape as proxy/providers/anthropic.mjs, so proxy/server.mjs doesn't care
// which is active.
export async function* streamCompletion({ apiKey, model, system, messages }) {
  if (!apiKey) throw new Error('TOGETHER_API_KEY is not configured on the proxy');

  const resp = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 2000,
      stream: true,
    }),
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Together API returned ${resp.status}: ${text.slice(0, 300)}`);
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
      const raw = dataLine.slice(5).trim();
      if (raw === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        continue;
      }
      if (evt.error) throw new Error(evt.error.message || 'Together stream error');
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}
