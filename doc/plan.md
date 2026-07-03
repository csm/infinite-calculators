# Infinite Calculators — Plan

A website that produces on-demand calculators from a natural-language description of what
the user wants to calculate. The app is written in **Clojurust** (a Clojure dialect
implemented in Rust) compiled to **WebAssembly**. Because Clojurust embeds its own
interpreter, the app can *generate and execute new Clojure code at runtime* — each
calculator is a freshly generated program, evaluated in a sandbox, and rendered with
**replicant** (cljrs port, in progress). Generation is done by an LLM running either
**in-browser via WebLLM** or on a **hosted model** the user can opt into.

---

## 1. User experience

### Core flow

1. User types a description: *"mortgage payments with extra principal payments"*,
   *"how much paint do I need for a room"*, *"caffeine half-life in my body"*.
2. The app streams a generation progress view while the model produces calculator code.
3. The generated calculator appears as a card: labeled inputs (with sensible defaults),
   live-computed outputs, units and formatting handled.
4. Every keystroke in an input re-runs the calculator's compute function and updates the
   outputs immediately (no "Calculate" button needed, though one can be shown for
   expensive calculators).

### Verification and tweaking controls

Two nested reveal levels, per calculator:

- **"Show logic"** — expands a human-readable explanation of the calculation: the
  formulas used, intermediate values for the *current* inputs, assumptions the model
  made (e.g. "assumes monthly compounding"), and sources of constants. This is data the
  generated code itself provides (see §4), rendered as structured steps — not a
  post-hoc LLM summary, so it cannot drift from what the code actually does.
- **"Show source"** — a further toggle inside the logic view revealing the raw generated
  Clojure source in an editor. The user can edit it and hit **Apply**, which re-parses,
  re-validates, and re-evaluates the code against the same sandbox and contract as
  generated code. **Revert** restores the last known-good source. Parse/eval/contract
  errors are shown inline with line numbers; the running calculator keeps its last good
  version until an edit succeeds.

### Secondary UX

- **Model picker**: "In-browser (private, free)" vs "Hosted (faster, better)" with an
  explanation of the tradeoff. In-browser shows model download size and progress on
  first use.
- **Refine**: a follow-up prompt box on each calculator ("also show total interest
  paid") that regenerates with the current source as context.
- **Library**: generated calculators persist in `localStorage` (source + description);
  a home screen lists them. Share/export as a URL fragment or downloadable `.clj` file.
- **Trust framing**: a persistent, low-key notice that calculators are AI-generated and
  the logic/source controls exist precisely so results can be verified.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser                                                          │
│                                                                  │
│  ┌────────────── JS host shell (thin) ──────────────────────┐    │
│  │ wasm loader · WebLLM (JS lib) · fetch to hosted API      │    │
│  │ localStorage · CodeMirror mount · WebGPU detection       │    │
│  └───────────────────────┬───────────────────────────────────┘   │
│                          │ interop boundary (§7)                 │
│  ┌───────────────────────┴───────────────────────────────────┐   │
│  │ app.wasm — Clojurust runtime                              │   │
│  │                                                           │   │
│  │  App core (Clojurust)                                     │   │
│  │   · state atom + event handlers                           │   │
│  │   · replicant rendering (hiccup → DOM)                    │   │
│  │   · generation orchestrator + validation/repair loop      │   │
│  │                                                           │   │
│  │  Sandboxed eval environment (embedded interpreter)        │   │
│  │   · restricted namespace, fuel-limited                    │   │
│  │   · runs generated calculator code                        │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ (hosted mode only)
                     ┌─────────┴──────────┐
                     │ API proxy (small)  │──► LLM provider API
                     │ holds the API key  │
                     └────────────────────┘
```

Three code "rings", with decreasing trust:

1. **JS host shell** — as small as possible; only what wasm cannot do: instantiate the
   module, drive WebLLM, expose `fetch`/`localStorage`, mount the code editor.
2. **App core** — trusted Clojurust code compiled ahead-of-time into the wasm module.
3. **Generated code** — untrusted; only ever run through the embedded interpreter's
   sandbox (§5), never granted interop access.

---

## 3. Application state and rendering

Single app-state atom, replicant-style pure rendering: `(render app-state) → hiccup`,
diffed to the DOM by replicant. Events dispatch as data
(`[:calc/set-input calc-id :rate 5.2]`), handled by pure reducers plus an effects layer
for LLM calls, eval, and storage.

```clojure
{:route      :home | [:calculator id]
 :backend    {:kind :webllm | :hosted
              :webllm {:model-id "…" :status :unloaded|:downloading|:ready :progress 0.42}
              :hosted {:endpoint "…" :status :ok}}
 :generation {:status :idle|:streaming|:validating|:repairing|:error
              :partial-text "…" :attempt 1 :error nil}
 :calculators
 {calc-id {:description "user's original prompt"
           :source      "(calculator {...})"        ; raw generated/edited text
           :spec        {...}                        ; evaluated contract map (§4)
           :inputs      {:loan-amount 250000 …}      ; current values
           :outputs     {:monthly-payment 1580.17 …} ; last compute result
           :ui          {:show-logic? false :show-source? false
                         :draft-source nil :source-error nil}
           :history     [...prior good sources, for revert]}}}
```

Recompute path: input event → validate/coerce input → run `:compute` in sandbox →
merge outputs → re-render. Compute failures surface on the card without destroying it.

**Replicant port risk**: the cljrs replicant port is in progress. Mitigation: define a
tiny internal rendering protocol (`(mount! el)`, `(render! el hiccup)`) that replicant
satisfies; if the port stalls, a fallback naive hiccup→DOM renderer (no diffing, full
re-render of the calculator card) satisfies the same protocol. Calculators are small
trees, so the fallback is acceptable for launch and swap-in later is invisible.

---

## 4. The calculator contract (what the LLM generates)

The single most important design decision: generated code must produce **one
well-defined data structure**, so the app — not the model — controls rendering, and the
logic view is guaranteed to describe the real computation.

The model emits one form, a call to a `calculator` constructor available in the sandbox:

```clojure
(calculator
 {:title "Mortgage payment"
  :description "Monthly payment for a fixed-rate mortgage, with optional extra principal."

  :inputs
  [{:id :principal :label "Loan amount" :type :number :default 300000
    :min 0 :unit "$"}
   {:id :rate      :label "Annual interest rate" :type :number :default 6.5
    :min 0 :max 30 :unit "%"}
   {:id :years     :label "Term" :type :select :default 30
    :options [{:value 15 :label "15 years"} {:value 30 :label "30 years"}]}
   {:id :extra     :label "Extra monthly payment" :type :number :default 0 :unit "$"}]

  :outputs
  [{:id :payment        :label "Monthly payment"     :format [:currency "USD"]}
   {:id :total-interest :label "Total interest paid" :format [:currency "USD"]}
   {:id :payoff-months  :label "Months to payoff"    :format [:integer]}]

  :compute
  (fn [{:keys [principal rate years extra]}]
    (let [r (/ rate 100 12)
          n (* years 12)
          payment (if (zero? r)
                    (/ principal n)
                    (/ (* principal r) (- 1 (Math/pow (+ 1 r) (- n)))))
          ;; ... amortization loop for extra payments ...
          ]
      {:payment payment :total-interest ti :payoff-months m}))

  :logic
  (fn [{:keys [principal rate years] :as in} out]
    [{:step "Monthly rate"
      :formula "r = annual rate / 12"
      :value (/ rate 100 12)}
     {:step "Payment (amortization formula)"
      :formula "P·r / (1 − (1+r)^−n)"
      :value (:payment out)}
     {:assumption "Fixed rate; interest compounds monthly; payments at month end."}])})
```

Contract rules, enforced by a spec validator after eval (§6):

- `:inputs` — declarative only; supported types: `:number`, `:integer`, `:select`,
  `:checkbox`, `:date`, `:text`. Constraints (`:min`/`:max`/`:step`) are enforced by the
  app's input widgets, not by generated code.
- `:compute` — a **pure function** of the inputs map returning the outputs map. No side
  effects possible (the sandbox has none to offer). Must return every declared output id.
- `:logic` — a function of `(inputs, outputs)` returning structured explanation steps
  (`:step`/`:formula`/`:value`/`:assumption`). Because it receives live values, the
  "Show logic" panel shows the actual intermediate numbers for the user's inputs.
- `:format` — a closed set of formatters (`:currency`, `:percent`, `:integer`,
  `:decimal`, `:duration`, `:unit`) implemented by the app.

The **source view shows exactly this text**; editing it and applying re-runs the same
eval + validation pipeline. There is no second representation to fall out of sync.

---

## 5. Dynamic evaluation and sandboxing

The embedded Clojurust interpreter evaluates generated/edited source. Untrusted code
gets a deliberately impoverished environment:

- **Allowlisted bindings only**: `clojure.core` arithmetic/collection/string functions,
  `Math/*`, the `calculator` constructor. Explicitly absent: any JS/host interop, `eval`
  itself, `def`/namespace mutation, atoms/state, I/O of any kind. The sandbox
  environment is constructed fresh per evaluation — nothing persists between runs.
- **Fuel limits**: the interpreter runs with a step budget (e.g. 10M reductions per
  `:compute` call) and a collection-size guard, so a generated infinite loop or memory
  bomb terminates with a "computation too expensive" error rather than hanging the tab.
  (If Clojurust's interpreter lacks fuel metering, this is a required upstream feature —
  budget for it early; it is the only hard blocker in the whole design.)
- **Determinism**: no clock, no randomness in the sandbox (a `:date` input exists for
  "today"-relative calculators, supplied by the app as an input default instead).
- Worst case, a malicious/buggy generation can only burn its fuel budget and produce a
  wrong number — which the logic and source views exist to let users catch.

Wasm itself provides the outer isolation ring; the sandbox is about protecting the
*app's* integrity and the user's compute, not the OS.

---

## 6. Generation pipeline

```
prompt ──► build messages ──► model backend (stream) ──► extract code block
                                                              │
                       ┌── error feedback loop (≤2 retries) ──┤
                       │                                      ▼
                  repair prompt ◄── failure ── read → eval → validate spec
                                                              │ pass
                                                              ▼
                                                   smoke test: run :compute
                                                   and :logic on defaults
                                                              │ pass
                                                              ▼
                                                      install calculator
```

- **System prompt**: the contract from §4 (types, rules, the exact allowlisted function
  set), 3–4 few-shot examples covering distinct shapes (pure formula, iterative
  computation, select-driven branching, date math), and hard rules: *one* `(calculator …)`
  form, only allowlisted functions, must include `:logic` with real assumptions.
- **Validation stages**, each producing a machine-readable error that is fed back into a
  repair attempt: (1) reader parse; (2) eval in sandbox; (3) contract/spec validation
  (shapes, ids match between `:inputs`/`:outputs`/`:compute` result); (4) smoke test —
  run `:compute` and `:logic` on the declared defaults, check outputs are finite numbers
  where numeric formats are declared.
- **Repair**: on failure, re-prompt with the failing source plus the specific error
  ("`:compute` returned NaN for `:total-interest` with default inputs"). Two retries,
  then surface a friendly error with a "try rephrasing" hint and the raw failure behind
  a details toggle. This loop is what makes small in-browser models viable.
- **Streaming UX**: token stream is shown live (as dimmed source scrolling by) so the
  wait feels shorter and reinforces the "it writes real code" framing.
- **Refinement** reuses the pipeline with the current (possibly user-edited) source
  included in the messages.

---

## 7. Model backends

One protocol, two implementations:

```clojure
(defprotocol ModelBackend
  (ensure-ready! [_ on-progress])        ; download/init (webllm) or ping (hosted)
  (generate!     [_ messages on-token on-done on-error])
  (info          [_]))                   ; name, size, privacy blurb for the picker
```

### WebLLM backend (in-browser)

- Uses the WebLLM JS library over the interop boundary; requires WebGPU (detect and
  gray out the option with an explanation when absent — e.g. Firefox without the flag).
- Default model: a small instruct model with strong code output in the 3–8B class
  (e.g. Qwen-coder or Llama-class at q4); exact pick decided by an evaluation run of the
  §10 prompt suite. Model weights cache in browser storage after first download
  (hundreds of MB — the picker must say so up front).
- Selling points surfaced in UI: fully private (prompt never leaves the machine), free,
  works offline after first load.
- Expect weaker generations → the repair loop (§6) and few-shot examples carry more
  weight; keep the contract small and regular for this reason.

### Hosted backend

- Requests go to a **small API proxy** (single serverless function) that holds the
  provider API key, enforces rate limits per client, and passes through SSE streaming.
  Shipping keys to the browser is off the table for a public site; a "bring your own
  key / custom endpoint" advanced setting can exist for self-hosters and dev use.
- Provider-agnostic proxy interface (messages in, token stream out) so the provider can
  change without touching the client.
- Default for users who don't care: hosted (better results); the picker makes the
  private option prominent.

Backend choice persists in `localStorage`. If WebLLM init fails mid-session (GPU loss,
storage eviction), offer one-click switch to hosted rather than failing the generation.

---

## 8. Source editing UX details

- Editor: CodeMirror 6 (via JS interop) with Clojure syntax highlighting and bracket
  matching; a plain `<textarea>` is the milestone-1 stand-in.
- **Apply** runs stages 1–4 of §6 on the edited text (no LLM involved). Errors annotate
  the editor (line/col from the reader where available) and the calculator keeps
  running on the last good version.
- **Revert** restores the last applied source; `:history` keeps prior good versions so
  an "undo apply" is possible.
- An "edited" badge appears on calculators whose source no longer matches the original
  generation, with a diff view (nice-to-have) and "regenerate from description" escape
  hatch.

---

## 9. Repository layout

```
/doc/plan.md                  this document
/src/app/                     Clojurust app core
  core.cljrs                  entry, state atom, event loop
  render.cljrs                views (hiccup): home, calculator card, logic/source panels
  contract.cljrs              calculator spec + validator + formatters
  sandbox.cljrs               sandbox env construction, fuel-limited eval wrapper
  genpipe.cljrs               generation orchestration, prompts, repair loop
  backend.cljrs               ModelBackend protocol + webllm/hosted impls
  storage.cljrs               localStorage persistence, share links
/src/host/                    JS shell: wasm boot, webllm glue, editor mount, interop
/proxy/                       hosted-model API proxy (serverless function)
/prompts/                     system prompt + few-shot examples (data, versioned)
/test/                        unit tests + generation eval suite (§10)
/build/                       Clojurust→wasm build scripts, dev server
```

---

## 10. Testing strategy

- **Unit** (pure Clojurust, run natively for speed): contract validator, formatters,
  reducers, sandbox allowlist (assert that interop/IO symbols resolve to *nothing*),
  fuel-limit behavior (an intentional infinite loop must terminate with the right error).
- **Golden calculators**: a set of hand-written contract-conforming calculators
  (mortgage, BMI, tip split, date diff, unit conversion) exercised end-to-end —
  eval → render → input change → recompute → logic panel contents.
- **Generation eval suite** (run on demand, not in CI-critical path): ~40 real prompts
  across domains; measure per-backend pass rate through the §6 pipeline, repair-loop
  attempt counts, and smoke-test numeric sanity. This suite decides the default WebLLM
  model and catches prompt regressions.
- **Browser e2e** (Playwright): boot wasm, generate against a *mocked* backend fixture,
  toggle logic/source, edit source with an introduced bug, verify inline error + revert.

---

## 11. Milestones

1. **Walking skeleton** — Clojurust→wasm builds and boots; hand-written calculator map
   in app state renders (replicant or fallback renderer); inputs recompute outputs.
   *Proves the runtime + rendering stack before any LLM work.*
2. **Sandbox + contract** — eval a calculator from a source string in the restricted
   env with fuel limits; validator + smoke test; textarea source editing with
   apply/revert. *The app is now fully useful with pasted code.*
3. **Hosted generation** — proxy function, streaming, full pipeline with repair loop;
   logic panel. *First end-to-end "describe → calculator" moment.*
4. **WebLLM backend** — model download UX, backend picker, eval suite to pick the
   default model, tune prompts/repair for the small model.
5. **Polish** — CodeMirror editor, library/persistence, share links, refine prompts,
   edited-badge/diff, trust framing, mobile layout.
6. **Hardening** — fuel/allowlist audit, rate limiting on the proxy, generation eval
   regression run, cross-browser (WebGPU matrix) pass.

---

## 12. Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| Clojurust interpreter lacks fuel metering / eval hooks | Blocks §5 | Verify first; contribute upstream early (milestone 2 dependency) |
| Replicant cljrs port incomplete | Blocks rendering | Renderer protocol + naive fallback renderer (§3) |
| Small WebLLM models produce invalid contracts | Poor in-browser UX | Tight contract, few-shot, repair loop, eval-driven model choice; hosted as default |
| Wasm binary size (interpreter included) | Slow first load | Measure at milestone 1; wasm-opt, lazy-load webllm, brotli |
| Generated math is subtly wrong | User trust | Logic panel with live intermediates, editable source, smoke tests, trust framing |
| Proxy abuse (open LLM endpoint) | Cost | Rate limit by IP + lightweight token, cap tokens/request, no system-prompt override |

Open questions to resolve during milestone 1–2:

- Clojurust↔JS interop ergonomics: callback-based streaming from WebLLM into wasm —
  confirm the boundary supports async callbacks cleanly, or buffer via polling.
- Does Clojurust's `Math/pow`-style host math exist in-sandbox, or does the sandbox need
  its own math namespace?
- Share-link format: source in URL fragment (size limits) vs. paste-only export.
