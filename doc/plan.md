# Infinite Calculators — Plan

A website that produces on-demand calculators from a natural-language description of what
the user wants to calculate. The app is written in **Clojurust** (a Rust-hosted Clojure
dialect) running in the browser via the **cljrs-wasm** WebAssembly runtime. Because the
wasm runtime *is* an interpreter, the app can generate and execute new Clojure code at
runtime — each calculator is a freshly generated program, evaluated in a sandbox, and
rendered with **replicant** (Clojurust port in progress). Generation is done by an LLM
running either **in-browser via WebLLM** or on a **hosted model** the user can opt into.

## 0. Reference projects and known state

| Project | Where | State (as of 2026-07-03) |
|---|---|---|
| Clojurust | github.com/csm/clojurust · docs.clj.rs | Tiered runtime (tree-walk → IR → Cranelift JIT, AOT to native). 25+ crates under the `cljrs-` prefix. 880+ tests; phases 1–12 largely complete. EPL licensed. |
| cljrs-wasm | crates.io `cljrs-wasm` 0.1.204 (2026-07-02) | Browser runtime via wasm-bindgen. Exposes a `Repl` class: `new Repl()`, async `eval(code) → Promise<EvalResult>` with `output()`, `result()` (stringified), `is_error()`. Full core.async (no blocking ops — no threads in wasm). Interpreter-only in wasm (no IR/JIT/compiled modes), no filesystem, no Rust FFI, **no DOM access yet**. |
| replicant (upstream) | github.com/cjohansen/replicant | Stable, feature-complete, zero-dependency hiccup→DOM renderer, v2026.06.2. |
| replicant (cljrs port) | github.com/csm/replicant, branch `claude/replicant-clojurust-wasm-lo6a5f` | `:rust` renderer backend added; pure-data components pass under cljrs CI. Needs a **cljrs-dom** backend implementation (requirements documented in-branch). Known blockers: `extend-via-metadata` across namespaces, `WrongType` errors in attribute prep/apply, missing core fns in current cljrs (`declare`, `run!`, `some->>`; `unchecked-int` absent). |

Facts above that shape this plan:

1. **Everything in wasm is interpreted.** There is no AOT-into-wasm path today, so the
   app core itself ships as `.cljrs` source, loaded into a `Repl` at boot. "Trusted" vs
   "untrusted" code is therefore a matter of *which Repl instance and environment* code
   is evaluated in, not compiled-vs-interpreted.
2. **The JS boundary is string-shaped.** `EvalResult.result()` returns a stringified
   value. Structured JS↔cljrs data exchange (EDN/JSON marshalling, JS→cljrs callbacks)
   is thin today and is a named workstream (§7).
3. **No DOM access from cljrs yet.** The replicant port's missing piece is a `cljrs-dom`
   backend; providing it (or the data-driven alternative in §3) is on this project's
   critical path.
4. **No fuel/step limits in the interpreter.** Sandboxing untrusted code instead uses a
   dedicated Repl instance in a **Web Worker with a watchdog timeout** (§5) — worker
   termination is the enforcement mechanism the platform already gives us. Interpreter
   fuel metering becomes an upstream nice-to-have, not a blocker.

---

## 1. User experience

### Core flow

1. User types a description: *"mortgage payments with extra principal payments"*,
   *"how much paint do I need for a room"*, *"caffeine half-life in my body"*.
2. The app streams a generation progress view while the model produces calculator code.
3. The generated calculator appears as a card: labeled inputs (with sensible defaults),
   live-computed outputs, units and formatting handled.
4. Every input change re-runs the calculator's compute function and updates the outputs
   immediately (no "Calculate" button needed, though one can be shown for expensive
   calculators).

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
  a home screen lists them. Share/export as a URL fragment or downloadable `.cljrs` file.
- **Trust framing**: a persistent, low-key notice that calculators are AI-generated and
  the logic/source controls exist precisely so results can be verified.

---

## 2. Architecture overview

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser                                                             │
│                                                                     │
│  ┌────────────── JS host shell ─────────────────────────────────┐   │
│  │ boots cljrs-wasm · loads app .cljrs sources into main Repl   │   │
│  │ WebLLM (JS lib) · fetch to hosted proxy · localStorage       │   │
│  │ CodeMirror mount · DOM effector (§3) · worker management     │   │
│  └──────────┬──────────────────────────────────┬────────────────┘   │
│             │ eval / callbacks                 │ postMessage        │
│  ┌──────────┴───────────────────┐   ┌──────────┴─────────────────┐  │
│  │ MAIN Repl (trusted)          │   │ Web Worker                 │  │
│  │ cljrs-wasm instance          │   │  ┌──────────────────────┐  │  │
│  │  · app core (state, events)  │   │  │ SANDBOX Repl         │  │  │
│  │  · replicant rendering       │   │  │ (untrusted)          │  │  │
│  │  · generation orchestrator   │   │  │  · restricted env    │  │  │
│  │  · contract validation       │   │  │  · runs generated    │  │  │
│  │                              │   │  │    calculator code   │  │  │
│  └──────────────────────────────┘   │  └──────────────────────┘  │  │
│                                     │  watchdog: timeout → kill  │  │
│                                     └────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ (hosted mode only)
                     ┌─────────┴──────────┐
                     │ API proxy (small)  │──► LLM provider API
                     │ holds the API key  │
                     └────────────────────┘
```

Three code "rings", with decreasing trust:

1. **JS host shell** — as small as possible; only what cljrs cannot do today: boot the
   wasm module and Repl instances, drive WebLLM, expose `fetch`/`localStorage`, apply
   DOM effects, mount the code editor, manage the sandbox worker.
2. **App core** — trusted Clojurust source, bundled with the site and eval'd into the
   main Repl at boot. (No AOT-into-wasm exists; if Clojurust later gains it, this ring
   compiles and the architecture is unchanged.)
3. **Generated code** — untrusted; only ever evaluated in the sandbox Repl inside the
   worker, in a restricted environment, never in the main Repl.

Boot sequence: shell instantiates cljrs-wasm → `new Repl()` → evals the bundled app
sources (concatenated, ordered) → app takes over via the render loop. Prebuilt IR
bundles for clojure.core are embedded in cljrs-wasm, so core function dispatch is fast
even though user code is tree-walked.

---

## 3. Application state and rendering

Single app-state atom, replicant-style pure rendering: `(render app-state) → hiccup`,
diffed to the DOM by replicant. Events dispatch as data
(`[:calc/set-input calc-id :rate 5.2]`), handled by pure reducers plus an effects layer
for LLM calls, sandbox eval, and storage. core.async (which cljrs-wasm supports fully)
carries async effect results back into the event loop.

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
           :spec        {...}                        ; validated contract map (§4)
           :inputs      {:loan-amount 250000 …}      ; current values
           :outputs     {:monthly-payment 1580.17 …} ; last compute result
           :ui          {:show-logic? false :show-source? false
                         :draft-source nil :source-error nil}
           :history     [...prior good sources, for revert]}}}
```

Recompute path: input event → validate/coerce input → send `{:op :compute :calc-id …
:inputs …}` to the sandbox worker → result arrives (async) → merge outputs → re-render.
Compute failures surface on the card without destroying it. Because sandbox eval is
async, cards show a stale-output shimmer for the (normally imperceptible) round-trip.

### Rendering backend: two-phase plan

The replicant cljrs port has a `:rust` renderer backend whose pure-data layers pass CI,
but it needs a **cljrs-dom** backend and is currently blocked on interpreter issues
(`extend-via-metadata` across namespaces, attribute `WrongType` errors). Rather than
gate the whole project on that:

- **Phase A (launch): data-driven DOM effector.** The app's render layer produces
  hiccup; a small pure Clojurust differ produces a flat list of DOM operations
  (`[[:create-element id :div {...}] [:set-text id "…"] [:listen id :input [:calc/set-input …]] …]`)
  returned to the JS shell, which applies them and routes events back as data. This
  keeps *all* logic in Clojurust and needs only the string-shaped eval boundary that
  exists today. Calculator UIs are small trees; a simple keyed differ (or even
  card-granularity re-render) is fine.
- **Phase B: replicant proper.** Implement `cljrs-dom` against the requirements
  documented in the port branch, help land the interpreter fixes upstream, and swap the
  effector for replicant's `:rust` backend behind the same
  `(mount! el)` / `(render! el hiccup)` protocol. Views don't change — they're hiccup
  either way.

Phase A's differ and op vocabulary should deliberately mirror what `cljrs-dom` needs,
so Phase A work *is* groundwork for the port rather than throwaway.

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
- **Dialect subset**: generated code must stay within a conservative, tested core
  subset. The current cljrs interpreter has gaps (`declare`, `run!`, `some->>`,
  `unchecked-int` have been missing at various recent versions; `extend-via-metadata`
  is buggy across namespaces) — the prompt lists banned/unavailable forms, the
  validator rejects them by symbol scan before eval, and the golden-calculator suite
  (§10) pins exactly which forms the shipped cljrs version supports.

The **source view shows exactly this text**; editing it and applying re-runs the same
eval + validation pipeline. There is no second representation to fall out of sync.

Contract note: `:compute` and `:logic` are closures living in the sandbox Repl. The
main-Repl-side `:spec` holds only the *data* parts (inputs/outputs/title); invoking
compute/logic is always a worker round-trip keyed by calc-id (§5).

---

## 5. Dynamic evaluation and sandboxing

Untrusted code never touches the main Repl. It runs in a **sandbox Repl instance inside
a dedicated Web Worker**:

- **Isolation**: the worker's JS scope exposes *nothing* to the wasm module beyond the
  postMessage protocol — no `fetch`, no DOM (workers have none anyway), no storage.
  Even a hypothetical interop escape from the interpreter lands in an empty room.
- **Restricted environment inside the Repl**: calculators are eval'd in a fresh
  namespace whose refers are an allowlist — `clojure.core` arithmetic / collection /
  string functions, `Math/*`, and the `calculator` constructor. Explicitly absent:
  `eval`, `read-string`, namespace/var mutation outside the calc ns, atoms/agents,
  core.async, and anything I/O-shaped. One sandbox Repl hosts many calculators, one
  namespace each; namespaces are discarded on regeneration.
- **Resource limits via watchdog, not fuel**: cljrs has no interpreter fuel metering
  today. Instead, every `:compute`/`:logic` invocation carries a deadline (e.g. 2s;
  generation smoke tests 5s). On timeout the shell **terminates the worker**, reports
  "computation too expensive" on the card, spins up a replacement worker, and re-evals
  the sources of the *other* installed calculators from their stored text (cheap —
  interpreter startup is designed for immediate start). Memory bombs are similarly
  bounded: the worker dies, the tab survives.
  - Upstream nice-to-have: fuel/step budgets in the cljrs interpreter would make
    termination surgical (fail one call instead of recycling the worker). File the
    issue early; don't block on it.
- **Determinism**: no clock, no randomness in the sandbox (a `:date` input exists for
  "today"-relative calculators, supplied by the app as an input default instead).
- Worst case, a malicious/buggy generation burns its deadline and produces a wrong
  number — which the logic and source views exist to let users catch.

Worker protocol (all payloads EDN strings, since the eval boundary is string-shaped):

```
→ {:op :install  :calc-id "c1" :source "(calculator {…})"}
← {:op :installed :calc-id "c1" :spec {…data parts…}}     ; or :error {…}
→ {:op :compute  :calc-id "c1" :inputs {…} :deadline-ms 2000}
← {:op :computed :calc-id "c1" :outputs {…}}
→ {:op :logic    :calc-id "c1" :inputs {…} :outputs {…}}
← {:op :logic    :calc-id "c1" :steps [{…}]}
```

---

## 6. Generation pipeline

```
prompt ──► build messages ──► model backend (stream) ──► extract code block
                                                              │
                       ┌── error feedback loop (≤2 retries) ──┤
                       │                                      ▼
                  repair prompt ◄── failure ── read → symbol scan → sandbox eval
                                                              │        → spec validate
                                                              │ pass
                                                              ▼
                                                   smoke test: run :compute
                                                   and :logic on defaults
                                                              │ pass
                                                              ▼
                                                      install calculator
```

- **System prompt**: the contract from §4 (types, rules, the exact allowlisted function
  set, the banned/unavailable-forms list for the pinned cljrs version), 3–4 few-shot
  examples covering distinct shapes (pure formula, iterative computation, select-driven
  branching, date math), and hard rules: *one* `(calculator …)` form, only allowlisted
  functions, must include `:logic` with real assumptions.
- **Validation stages**, each producing a machine-readable error that is fed back into a
  repair attempt: (1) reader parse; (2) symbol scan against the allowlist (catches both
  sandbox violations and known cljrs gaps *before* eval, with a clean error message);
  (3) eval in sandbox; (4) contract/spec validation (shapes, ids match between
  `:inputs`/`:outputs`/`:compute` result); (5) smoke test — run `:compute` and `:logic`
  on the declared defaults under the watchdog deadline, check outputs are finite
  numbers where numeric formats are declared.
- **Repair**: on failure, re-prompt with the failing source plus the specific error
  ("`:compute` returned NaN for `:total-interest` with default inputs"). Two retries,
  then surface a friendly error with a "try rephrasing" hint and the raw failure behind
  a details toggle. This loop is what makes small in-browser models viable.
- **Streaming UX**: token stream is shown live (as dimmed source scrolling by) so the
  wait feels shorter and reinforces the "it writes real code" framing.
- **Refinement** reuses the pipeline with the current (possibly user-edited) source
  included in the messages.

---

## 7. JS interop boundary

cljrs-wasm's surface today: `new Repl()`; async `eval(code)` returning a Promise of
`EvalResult` (`output()`, `result()` as a *string*, `is_error()`); persistent scheduler
so core.async tasks and channels survive across evals. No structured value marshalling,
no registered-callback mechanism documented.

Consequences and plan:

- **EDN-over-strings everywhere.** All shell↔Repl traffic is EDN text: the shell calls
  `repl.eval("(app/handle-event! \"[:calc/set-input …]\")")` (event as EDN string,
  reader-parsed inside), and reads effect requests back as the eval's result string
  (`pr-str` of `{:effects [[:dom-ops […]] [:llm-generate {…}] …]}`). One generic
  `dispatch!(edn-string) → effects-edn` entry point keeps the JS glue dumb and the
  protocol testable from pure Clojurust.
- **Async results ride core.async.** Effects that complete later (LLM tokens, worker
  replies, storage reads) re-enter via the same `dispatch!` with a completion event.
  WebLLM's token callback becomes a stream of `[:gen/token "…"]` dispatches (batched
  per animation frame to keep eval traffic sane).
- **Upstream wishlist** (file early, adopt as released, none blocking): structured
  JSON/JS-value results on `EvalResult`; a host-function registration hook so the shell
  can expose `fetch`/DOM as capabilities to the *main* Repl only; interpreter fuel
  budgets (§5). The cljrs release cadence is fast (0.1.194→0.1.204 within the replicant
  port's lifetime), so expect to ride versions and re-pin frequently; the golden suite
  (§10) is the re-pin gate.

---

## 8. Model backends

One protocol, two implementations:

```clojure
(defprotocol ModelBackend
  (ensure-ready! [_ on-progress])        ; download/init (webllm) or ping (hosted)
  (generate!     [_ messages on-token on-done on-error])
  (info          [_]))                   ; name, size, privacy blurb for the picker
```

(Implementation detail: the protocol lives in Clojurust; the shell-side WebLLM/fetch
machinery is reached via the effects protocol of §7.)

### WebLLM backend (in-browser)

- Uses the WebLLM JS library in the shell; requires WebGPU (detect and gray out the
  option with an explanation when absent — e.g. Firefox without the flag).
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

## 9. Source editing UX details

- Editor: CodeMirror 6 (shell-side JS) with Clojure syntax highlighting and bracket
  matching; a plain `<textarea>` is the milestone-1 stand-in.
- **Apply** runs stages 1–5 of §6 on the edited text (no LLM involved). Errors annotate
  the editor (line/col from the reader where available) and the calculator keeps
  running on the last good version.
- **Revert** restores the last applied source; `:history` keeps prior good versions so
  an "undo apply" is possible.
- An "edited" badge appears on calculators whose source no longer matches the original
  generation, with a diff view (nice-to-have) and "regenerate from description" escape
  hatch.

---

## 10. Repository layout

```
/doc/plan.md                  this document
/src/app/                     Clojurust app core (.cljrs, eval'd into main Repl at boot)
  core.cljrs                  entry, state atom, event loop, dispatch!/effects protocol
  render.cljrs                views (hiccup): home, calculator card, logic/source panels
  dom.cljrs                   Phase A hiccup differ → DOM-op lists (§3)
  contract.cljrs              calculator spec + validator + symbol scan + formatters
  genpipe.cljrs               generation orchestration, prompts, repair loop
  backend.cljrs               ModelBackend protocol + webllm/hosted impls
  storage.cljrs               localStorage persistence, share links
/src/sandbox/                 sources eval'd into the sandbox Repl (worker side)
  env.cljrs                   allowlist env construction, calculator constructor
  protocol.cljrs              install/compute/logic op handlers
/src/host/                    JS shell: cljrs-wasm boot, worker mgmt, DOM effector,
                              webllm glue, editor mount, storage/fetch effects
/proxy/                       hosted-model API proxy (serverless function)
/prompts/                     system prompt + few-shot examples (data, versioned)
/test/                        unit tests + golden calculators + generation eval suite
/build/                       source-bundle build (order + concat .cljrs), dev server,
                              cljrs version pin
```

---

## 11. Testing strategy

- **Unit** (pure Clojurust; run under native `cljrs test` for speed, same sources as
  wasm): contract validator, symbol scan, formatters, reducers, hiccup differ
  (DOM-op output as data), sandbox env construction (assert banned symbols resolve to
  nothing).
- **Golden calculators**: a set of hand-written contract-conforming calculators
  (mortgage, BMI, tip split, date diff, unit conversion) exercised end-to-end —
  install → compute → input change → recompute → logic panel contents. Doubles as the
  **cljrs version re-pin gate**: run against each new cljrs-wasm release before
  adopting it, catching stdlib gaps/regressions like those hit by the replicant port.
- **Sandbox behavior** (browser): an intentional infinite loop must trip the watchdog,
  kill and replace the worker, and leave other installed calculators working.
- **Generation eval suite** (run on demand, not in CI-critical path): ~40 real prompts
  across domains; measure per-backend pass rate through the §6 pipeline, repair-loop
  attempt counts, and smoke-test numeric sanity. This suite decides the default WebLLM
  model and catches prompt regressions.
- **Browser e2e** (Playwright): boot wasm, generate against a *mocked* backend fixture,
  toggle logic/source, edit source with an introduced bug, verify inline error + revert.

---

## 12. Milestones

1. **Walking skeleton** — shell boots cljrs-wasm, evals bundled app sources into the
   main Repl; `dispatch!` round-trip works; Phase A DOM effector renders a hand-written
   calculator map; inputs recompute outputs (in-main-Repl for now). *Proves the
   boot/eval/effects/rendering stack before any sandbox or LLM work.*
2. **Sandbox + contract** — sandbox Repl in a worker with the §5 protocol and watchdog;
   allowlist env; validator + symbol scan + smoke test; textarea source editing with
   apply/revert. *The app is now fully useful with pasted code.*
3. **Hosted generation** — proxy function, streaming, full pipeline with repair loop;
   logic panel. *First end-to-end "describe → calculator" moment.*
4. **WebLLM backend** — model download UX, backend picker, eval suite to pick the
   default model, tune prompts/repair for the small model.
5. **Replicant swap (Phase B)** — implement `cljrs-dom` per the port branch's
   documented requirements, pick up interpreter fixes as cljrs releases land, swap the
   Phase A effector for replicant's `:rust` backend behind the renderer protocol.
   *Runs in parallel with 3–4; not on the launch critical path.*
6. **Polish** — CodeMirror editor, library/persistence, share links, refine prompts,
   edited-badge/diff, trust framing, mobile layout.
7. **Hardening** — allowlist/watchdog audit, rate limiting on the proxy, generation
   eval regression run, cross-browser (WebGPU matrix) pass, wasm size budget
   (interpreter + embedded IR bundles; measure at milestone 1, wasm-opt + brotli).

---

## 13. Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| cljrs stdlib gaps / fast-moving releases (`declare`, `run!`, `some->>` recently missing; 0.1.194→204 in weeks) | Generated & app code breaks on version bumps | Pin cljrs-wasm; golden-calculator suite as re-pin gate; banned-forms list in prompt + symbol scan |
| `extend-via-metadata` cross-namespace bug, attribute `WrongType` errors (replicant port blockers) | Blocks Phase B rendering | Phase A data-driven DOM effector ships first; replicant swap is off the critical path |
| No DOM access from cljrs-wasm | Blocks any in-Repl rendering | Phase A effector needs only string eval; `cljrs-dom` is the tracked Phase B dependency |
| String-only eval results | Clunky interop, perf overhead | EDN-over-strings protocol (§7); batch event dispatches; upstream structured-result request |
| No interpreter fuel limits | Runaway generated code | Worker + watchdog kill/respawn (§5); upstream fuel request is nice-to-have |
| Small WebLLM models produce invalid contracts | Poor in-browser UX | Tight contract, few-shot, repair loop, eval-driven model choice; hosted as default |
| Wasm binary size (interpreter + IR bundles) | Slow first load | Measure at milestone 1; wasm-opt, brotli, lazy-load webllm |
| Generated math is subtly wrong | User trust | Logic panel with live intermediates, editable source, smoke tests, trust framing |
| Proxy abuse (open LLM endpoint) | Cost | Rate limit by IP + lightweight token, cap tokens/request, no system-prompt override |

Open questions to resolve during milestones 1–2:

- Per-eval cost of the string boundary at input-slider frequency — if `dispatch!` evals
  are too slow at 60Hz, coalesce input events (trailing debounce) before crossing.
- Can two `Repl` instances share one wasm module instantiation, or does the worker load
  its own copy? (Affects memory and startup; either works functionally.)
- `Math/*` availability and float semantics in the cljrs sandbox env — confirm which
  math builtins exist in-interpreter vs. need adding to the allowlisted env.
- Namespace teardown in a long-lived sandbox Repl: confirm discarded calculator
  namespaces are actually collectable (GC is non-moving mark-and-sweep) or recycle the
  worker after N regenerations.
- Share-link format: source in URL fragment (size limits) vs. paste-only export.
