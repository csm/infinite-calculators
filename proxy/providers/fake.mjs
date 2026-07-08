// Deterministic in-process fake provider for the generation e2e test
// (test/e2e/generation.mjs) -- no real LLM call, no API key, no network.
// Activated via GENERATION_PROVIDER=fake (see proxy/server.mjs). Looks at
// the final user turn to decide what to "generate": a description
// containing BROKEN_MARKER gets an invalid calculator on the first attempt
// (fails the sandbox smoke test) and a valid one once a repair turn (i.e.
// a manual :generation/retry, doc/plan.md §6) comes back, so this same
// fake exercises both the happy path and manual-retry recovery without any
// real model. ALWAYS_BROKEN_MARKER never recovers even on a repair turn,
// to exercise Dismiss on a failure that a retry wouldn't fix.
export const BROKEN_MARKER = 'MAKE_IT_BROKEN';
export const ALWAYS_BROKEN_MARKER = 'ALWAYS_BROKEN';
// The two truncation shapes a real provider's max_tokens signal produces
// (both stream their text first, then error, matching how the real
// providers only learn about the cutoff at the end of the stream):
// TRUNCATE_AFTER_CODE finished the fenced calculator and got cut off
// writing prose after it -- salvageable, must still install.
// TRUNCATE_MID_CODE got cut off inside the calculator form -- not
// salvageable, must fail with the truncation error (not a bare parse
// error, so the repair prompt's truncation hint fires).
export const TRUNCATE_AFTER_CODE_MARKER = 'TRUNCATE_AFTER_CODE';
export const TRUNCATE_MID_CODE_MARKER = 'TRUNCATE_MID_CODE';
const MAX_TOKENS_ERROR = 'response was cut off by the token limit before it finished (max_tokens)';

const GOOD_SOURCE = `(calculator
 {:title "Fake tip calculator"
  :description "Split a bill with a tip."
  :inputs [{:id :bill :label "Bill amount" :type :number :default 50.0 :unit "$"}
           {:id :tip-pct :label "Tip %" :type :number :default 18.0 :unit "%"}]
  :outputs [{:id :tip :label "Tip" :format [:currency "USD"]}
            {:id :total :label "Total" :format [:currency "USD"]}]
  :compute (fn [{:keys [bill tip-pct]}]
             (let [tip (* bill (/ tip-pct 100))]
               {:tip tip :total (+ bill tip)}))
  :logic (fn [{:keys [bill tip-pct]} out]
           [{:step "Tip" :formula "bill * tip% / 100" :value (:tip out)}])})`;

const BROKEN_SOURCE = `(calculator
 {:title "Fake tip calculator"
  :description "Split a bill with a tip."
  :inputs [{:id :bill :label "Bill amount" :type :number :default 50.0 :unit "$"}
           {:id :tip-pct :label "Tip %" :type :number :default 18.0 :unit "%"}]
  :outputs [{:id :tip :label "Tip" :format [:currency "USD"]}
            {:id :total :label "Total" :format [:currency "USD"]}]
  :compute (fn [{:keys [bill tip-pct]}]
             {:tip "not a number" :total (+ bill tip-pct)})
  :logic (fn [in out] [])})`;

export async function* streamCompletion({ messages }) {
  const last = messages[messages.length - 1]?.content || '';
  const isRepair = last.includes('It failed with:');
  const wantsBroken = last.includes(ALWAYS_BROKEN_MARKER) || (last.includes(BROKEN_MARKER) && !isRepair);
  const truncatesAfterCode = last.includes(TRUNCATE_AFTER_CODE_MARKER);
  const truncatesMidCode = last.includes(TRUNCATE_MID_CODE_MARKER);
  let text = '```clojure\n' + (wantsBroken ? BROKEN_SOURCE : GOOD_SOURCE) + '\n```';
  if (truncatesAfterCode) text += '\nThis calculator splits a bill by first computi';
  if (truncatesMidCode) text = text.slice(0, Math.floor(text.length / 2));

  // Yield in a few chunks so the client's streaming/partial-text path gets exercised too.
  const chunkSize = Math.max(1, Math.ceil(text.length / 4));
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
    await new Promise((r) => setTimeout(r, 5));
  }
  if (truncatesAfterCode || truncatesMidCode) throw new Error(MAX_TOKENS_ERROR);
}
