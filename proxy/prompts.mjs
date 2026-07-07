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

// A parse failure or an explicit token-limit error are both consistent with
// the response having been cut off before it finished (a real-world finding
// -- see doc/plan.md's milestone-3 notes and proxy/providers/*.mjs's
// finish_reason/stop_reason checks). Flagging this heuristically on a
// repair turn costs nothing if the guess is wrong (the advice -- be
// concise, skip prose -- is harmless for any other kind of failure too).
function truncationHint(priorError) {
  return /cut off|max_tokens|not valid clojure|exactly one/i.test(priorError || '')
    ? 'Your response may have been cut off before it finished, included stray content after ' +
        'the form, or is otherwise malformed. Respond with only the fenced code block -- no ' +
        'explanation before or after it, and nothing following the closing paren of the ' +
        '(calculator {...}) form -- and keep comments minimal, so the complete form fits well ' +
        'within the response budget.\n\n'
    : '';
}

export function buildMessages({ description, attempt, priorSource, priorError }) {
  const fewShot = EXAMPLES.flatMap((ex) => [
    { role: 'user', content: `Generate a calculator for: ${ex.description}` },
    { role: 'assistant', content: fence(ex.source) },
  ]);

  let finalTurn;
  if (attempt > 1 && priorSource) {
    finalTurn = {
      role: 'user',
      content:
        `Attempt ${attempt}: the previous calculator you generated for "${description}" ` +
        `failed validation. Previous source:\n${fence(priorSource)}\n\n` +
        `It failed with: ${priorError}\n\n` +
        truncationHint(priorError) +
        `Return a corrected, complete (calculator {...}) form that fixes this, following all rules above.`,
    };
  } else if (attempt > 1 && priorError) {
    // A repair attempt can arrive with no usable prior source at all (e.g.
    // the response never made it to a parseable calculator form in the
    // first place) -- still tell the model what went wrong instead of
    // silently retrying the original prompt with no context.
    finalTurn = {
      role: 'user',
      content:
        `Attempt ${attempt}: your previous response for "${description}" failed before a usable ` +
        `calculator could be extracted from it. It failed with: ${priorError}\n\n` +
        truncationHint(priorError) +
        `Please try again: generate a calculator for: ${description}`,
    };
  } else {
    finalTurn = { role: 'user', content: `Generate a calculator for: ${description}` };
  }

  return { system: SYSTEM_PROMPT, messages: [...fewShot, finalTurn] };
}
