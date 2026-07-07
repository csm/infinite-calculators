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
      // Real-world finding: 2000 was too tight for at least one model on a
      // mortgage-calculator prompt -- the response got cut off mid-form
      // (silently, since a truncated response looks the same as a complete
      // one until something tries to parse it), which surfaced downstream
      // as a confusing "could not parse source" error instead of a clear
      // truncation one. Raised for headroom; also now detected explicitly
      // below via finish_reason rather than left to fail parsing later.
      max_tokens: 4000,
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
      const finishReason = evt.choices?.[0]?.finish_reason;
      if (finishReason === 'length') {
        throw new Error('response was cut off by the token limit before it finished (max_tokens)');
      }
    }
  }
}
