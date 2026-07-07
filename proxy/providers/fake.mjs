// Deterministic in-process fake provider for the generation e2e test
// (test/e2e/generation.mjs) -- no real LLM call, no API key, no network.
// Activated via GENERATION_PROVIDER=fake (see proxy/server.mjs). Looks at
// the final user turn to decide what to "generate": a description
// containing BROKEN_MARKER gets an invalid calculator on the first attempt
// (fails the sandbox smoke test) and a valid one once the repair turn comes
// back, so this same fake exercises both the happy path and the §6 repair
// loop without any real model. ALWAYS_BROKEN_MARKER never recovers, to
// exercise giving up after doc/plan.md §6's two retries.
export const BROKEN_MARKER = 'MAKE_IT_BROKEN';
export const ALWAYS_BROKEN_MARKER = 'ALWAYS_BROKEN';

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
  const text = '```clojure\n' + (wantsBroken ? BROKEN_SOURCE : GOOD_SOURCE) + '\n```';

  // Yield in a few chunks so the client's streaming/partial-text path gets exercised too.
  const chunkSize = Math.max(1, Math.ceil(text.length / 4));
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
    await new Promise((r) => setTimeout(r, 5));
  }
}
