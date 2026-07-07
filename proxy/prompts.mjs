// Builds the full message list sent to the model: the versioned system
// prompt + few-shot examples from /prompts/ (doc/plan.md §6/§11), plus the
// user's description or, on a repair attempt (attempt > 1), the failing
// source and the specific validator/smoke-test error (doc/plan.md §6's
// repair loop). The system prompt always comes from here, never from the
// client -- see doc/plan.md §13's "no system-prompt override" mitigation.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYSTEM_PROMPT = readFileSync(join(root, 'prompts/system.md'), 'utf8');
const EXAMPLES = JSON.parse(readFileSync(join(root, 'prompts/examples.json'), 'utf8'));

function fence(source) {
  return '```clojure\n' + source.trim() + '\n```';
}

export function buildMessages({ description, attempt, priorSource, priorError }) {
  const fewShot = EXAMPLES.flatMap((ex) => [
    { role: 'user', content: `Generate a calculator for: ${ex.description}` },
    { role: 'assistant', content: fence(ex.source) },
  ]);

  const finalTurn =
    attempt > 1 && priorSource
      ? {
          role: 'user',
          content:
            `Attempt ${attempt}: the previous calculator you generated for "${description}" ` +
            `failed validation. Previous source:\n${fence(priorSource)}\n\n` +
            `It failed with: ${priorError}\n\n` +
            `Return a corrected, complete (calculator {...}) form that fixes this, following all rules above.`,
        }
      : { role: 'user', content: `Generate a calculator for: ${description}` };

  return { system: SYSTEM_PROMPT, messages: [...fewShot, finalTurn] };
}
