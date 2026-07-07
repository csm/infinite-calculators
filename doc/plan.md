# Infinite Calculators — Plan

A website that produces on-demand calculators from a natural-language description of what
the user wants to calculate. The app is written in **Clojurust** (a Rust-hosted Clojure
dialect) running in the browser via the **cljrs-wasm** WebAssembly runtime. Because the
wasm runtime *is* an interpreter, the app can generate and execute new Clojure code at
runtime — each calculator is a freshly generated program, evaluated in a sandbox, and
rendered with **replicant** (Clojurust port in progress). Generation is done by an LLM
running either **in-browser via WebLLM** or on a **hosted model** the user can opt into.

## 0. Reference projects and known state

| Project | Where | State (as of 2026-07-07) |
|---|---|---|
| Clojurust | github.com/csm/clojurust · docs.clj.rs | Tiered runtime (tree-walk → IR → Cranelift JIT, AOT to native). 25+ crates under the `cljrs-` prefix. 880+ tests; phases 1–12 largely complete. EPL licensed. |
| cljrs-wasm | crates.io `cljrs-wasm` 0.1.219 (2026-07-06) | Browser runtime via wasm-bindgen. Exposes a `Repl` class: `new Repl()`, async `eval(code) → Promise<EvalResult>` with `output()`, `result()` (stringified), `is_error()`. Full core.async (no blocking ops — no threads in wasm). Interpreter-only in wasm, no filesystem, no Rust FFI. **DOM access confirmed working**: `Repl::new()` natively registers a `cljrs.dom` namespace (via the `cljrs-dom` crate) exposing selection/creation/tree/attribute/class/content/style/event/hiccup primitives directly on real browser DOM nodes — verified end-to-end in a live Chromium session (see below). |
| replicant (upstream) | github.com/cjohansen/replicant | Stable, feature-complete, zero-dependency hiccup→DOM renderer, v2026.06.2. |
| replicant (cljrs port) | github.com/csm/replicant, `main` | `:rust` renderer backend (`replicant.dom/create-renderer`, `render`, `set-dispatch!`) is complete and merged to main. **Verified working against cljrs-wasm 0.1.219**: initial render, diffed re-render (attribute and text-child updates), and real DOM click events dispatching back into a Clojurust `*dispatch*` function all work in a live browser session (see `doc/cljrs-port/` for the harness). One interpreter bug found and worked around (below); no other blockers hit. |

**Verification performed this session**: built a throwaway Rust crate depending on `cljrs-wasm = "0.1.219"` (`pub use cljrs_wasm::*;` is enough — wasm-bindgen's custom sections survive re-export across the crate boundary), `wasm-pack build --target web` it (needs `wasm-opt = false` in `[package.metadata.wasm-pack.profile.release]`, since the sandboxed build environment can't reach the binaryen release download), served it, and drove a real Chromium instance via Playwright to eval Clojurust code against a live `Repl`. Confirmed: `cljrs.dom` primitives work directly; the full `replicant.dom` bundle (vendored under `vendor/replicant/`, see below) evaluates cleanly; `replicant.dom/render` mounts, diffs, and updates real DOM; `:on {:click [...]}` handlers fire through `replicant.dom/set-dispatch!` on real `click()` events.

Two concrete findings from that verification, both now load-bearing for how code is bundled/written in this project:

1. **`:require` cannot resolve a sibling namespace that only exists because its `(ns ...)` form was `eval`'d earlier in the same session.** cljrs-wasm's `Repl` has no filesystem/source-path, so `require` always falls through to a source-file loader lookup and fails with `Could not find namespace ... on source path` — even for namespaces we ourselves defined and fully evaluated moments earlier (this is *not* limited to natively-registered namespaces like `cljrs.dom`, as originally assumed). The fix, used throughout the vendored `replicant.*` bundle and to be used in our own `.cljrs` sources: replace intra-bundle `:require` clauses with `(alias 'x 'the.other.ns)` calls after the `ns` form. `:require` for genuine embedded stdlib namespaces (`clojure.string`, `clojure.walk`, confirmed present) works normally. This changes how §10's file layout is bundled — see the updated §3.
2. **`reify` method-parameter shadowing bug**: a `reify` method whose parameter is named the same as the protocol method itself (e.g. `(replace-child [this el insert-child replace-child] ...)`) does not shadow correctly — the body resolves the *outer* protocol fn/var, not the local binding, producing `WrongType: expected DomNode, got fn`. Worked around in the vendored `replicant.dom` by renaming the shadowing parameter. Filed as an upstream cljrs issue; not a blocker since the workaround is a one-line rename at each call site that needs it.

Two more findings from **this milestone's** verification (the sandbox worker + contract pipeline, §4–§6), both load-bearing for how the worker host talks to a Repl:

3. **A fresh `Repl.eval()` call resets unqualified-symbol resolution to a default namespace, even though `*ns*` introspection still reports the last one set.** Concretely: `(ns sandbox.env)` then, in a *later, separate* `.eval()` call, `(ns-name *ns*)` correctly returns `sandbox.env` — but a bare `calculator` symbol (defined in `sandbox.env`) resolves as `unbound symbol: calculator` in that same later call, and `(def x ...)` in it interns into `user`, not `sandbox.env`. Fix: any eval call that needs unqualified resolution or a `def` to land in a specific namespace must start with an explicit `(in-ns 'the.ns)` of its own, every time — `*ns*` persisting across calls cannot be relied on for this. `src/host/sandbox-worker.js`'s `:install` op does this (it's the one call that needs `calculator` to resolve unqualified, as the contract requires).
4. **`EvalResult.result()` always applies `pr-str` to the evaluated value, even when that value is already a string.** So a Clojure function returning a JSON string for the JS host to `JSON.parse` gets *double*-encoded: `.result()` is the pr-str of that string, not the string itself. `src/host/edn.js`'s `unwrapClojureString` undoes exactly this one layer before `JSON.parse`. Relatedly, `pr-str` leaves control characters other than `\n`/`\t`/`\r` unescaped, and a raw control byte embedded in a JSON string is illegal JSON that `JSON.parse` rejects — `app.json`'s keyword-value marker (§7) had to move from a control character to a plain-ASCII sentinel (`~kw~`) for exactly this reason.

Facts above that shape this plan:

1. **Everything in wasm is interpreted.** There is no AOT-into-wasm path today, so the
   app core itself ships as `.cljrs` source, loaded into a `Repl` at boot. "Trusted" vs
   "untrusted" code is therefore a matter of *which Repl instance and environment* code
   is evaluated in, not compiled-vs-interpreted.
2. **The JS boundary is string-shaped.** `EvalResult.result()` returns a stringified
   value. Structured JS↔cljrs data exchange (EDN/JSON marshalling, JS→cljrs callbacks)
   is thin today and is a named workstream (§7). This mostly matters for the sandbox
   worker protocol and LLM streaming now — rendering and UI event dispatch happen
   entirely inside the main Repl (see §3) and never need to cross the JS boundary per
   keystroke/click.
3. **DOM access from cljrs works**, via the natively-registered `cljrs.dom` namespace
   and the ported `replicant.dom` (`:rust` backend), both verified above. The two-phase
   rendering plan originally in this document (data-driven DOM effector, then a Phase B
   replicant swap) is **no longer necessary — go straight to replicant** (§3).
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

### Rendering backend: replicant, directly

`cljrs-dom` and the replicant `:rust` backend both work today (verified in §0) — there
is no need for a data-driven DOM-op effector as a stopgap. The app's render layer is a
plain `(render app-state) → hiccup` function; rendering and updates go straight through
`replicant.dom/render`, called from the main Repl on every state change:

```clojure
(replicant.dom/render root-el (render @app-state))
```

Events are wired the same way replicant does it everywhere: hiccup carries
`[:on {:click [:calc/set-input calc-id :rate]} ...]`-style data handlers, and
`(replicant.dom/set-dispatch! f)` is set once at boot to a function that receives
`(event action)` and applies the action to `app-state` (then re-renders). Because
`cljrs.dom/listen!` registers the callback natively and invokes it inside the same Repl,
**no event ever needs to cross the JS boundary** — the JS shell's only job is booting
the wasm module, evaling the bundled sources once, and handling the few things cljrs
genuinely cannot do itself (WebLLM, `fetch`, `localStorage`, worker management — §7).

Rendering therefore needs no protocol of its own distinct from replicant's; `render.cljrs`
just returns hiccup, same as any replicant app. The former Phase A/B split is gone —
milestone 5 in §12 is replaced by "wire the calculator card views to replicant" as part
of the walking skeleton (milestone 1), not a parallel late-stage workstream.

**Vendoring note**: cljrs-wasm ships no package manager reachable from the browser
build, so replicant's `.cljc` sources needed for the `:rust` backend are vendored
directly into this repo under `vendor/replicant/` (pinned to the upstream commit noted
in `vendor/replicant/NOTES.md`), patched per the two findings in §0 (`alias` instead of
intra-bundle `:require`; the `replace-child` param rename). Re-vendoring on a replicant
update means re-applying both patches — `vendor/replicant/NOTES.md` documents the exact
diff so this is mechanical.

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

**Verified this milestone** (throwaway Playwright probes against the pinned
cljrs-wasm 0.1.219, same method as the §0 replicant verification): `(ns foo
(:refer-clojure :only []))` does restrict *ordinary var-based* `clojure.core` fns —
`eval` and `clojure.core/eval` both come back `unbound symbol` after it, which is the
one exclusion that actually matters (it's the dynamic-code-loading escape hatch).
**But it does not hide the interpreter's `NativeFn`-tier bindings**: `atom`, `swap!`,
`reset!`, `read-string`, `ns`, `in-ns`, `intern`, `create-ns`, and `require` all
remain callable even with an empty `:only []` — these are wired as always-resolvable
primitives independent of ns refers, not vars subject to exclusion (an interpreter
limitation in the same family as the §0 `reify`-shadowing bug; not filed upstream
individually, but covered by the general "dialect subset" caveat). `ns-unmap` doesn't
exist at all (`unbound symbol: ns-unmap`), so there's no way to retroactively strip a
referred symbol either. **Consequence: there is no reliable language-level allowlist
in this interpreter version** — only `eval` is genuinely excludable; the rest of the
"explicitly absent" list below is aspirational, not enforced by the ns system.

This changes the security model from "restricted namespace is a real boundary" to:
**worker isolation is the only hard boundary; the namespace restriction is
defense-in-depth for the one thing it actually stops (`eval`) plus keeping dangerous
*namespaces* (`clojure.core.async`, `cljrs.dom`, storage/fetch) unreachable by simply
never loading them into the sandbox bundle** — a fully-qualified reference to a
namespace that was never `eval`'d into that Repl fails with "no such namespace"
regardless of refers, which was also verified. Since calculator code *can* create its
own atoms, call `read-string`, or even call `ns`/`in-ns`/`create-ns`/`intern`, letting
multiple calculators share one sandbox Repl (the original plan) would let one
calculator's generated code stomp another's namespace. **Revised architecture: one
Worker + one Repl per installed calculator**, not a shared Repl with one namespace per
calc. This is simpler to reason about (no cross-calc interference is possible even in
the worst case) and cheap: a fresh worker + wasm init + bundle eval was measured at
~50ms in the probe, matching the "interpreter startup is designed for immediate
start" assumption the watchdog-respawn design already depended on.

**Also verified**: `Worker.terminate()` reliably kills a worker stuck in a true
non-yielding tight loop (`(loop [i 0] (if true (recur (inc i)) :done))` inside a
synchronous `repl.eval` call) — termination doesn't wait for the JS/wasm to yield, and
a brand-new worker created immediately after works normally. The watchdog-kill-respawn
mechanism in the bullet below is not a hopeful design, it's a measured one.

Untrusted code never touches the main Repl. It runs in a **sandbox Repl instance inside
a dedicated Web Worker, one worker per installed calculator**:

- **Isolation**: the worker's JS scope exposes *nothing* to the wasm module beyond the
  postMessage protocol — no `fetch`, no DOM (workers have none anyway), no storage.
  Even a hypothetical interop escape from the interpreter lands in an empty room. This
  is the actual security boundary (see verification above).
- **Restricted environment inside the Repl**: each calculator's worker evals only the
  sandbox bundle (`clojure.core` plus `src/sandbox/*.cljrs` — no `core.async`, no
  `cljrs.dom`, no replicant) into a `(ns calc.sandbox (:refer-clojure :only []))`-style
  namespace, then the calculator source. This blocks `eval` genuinely and blocks any
  reference to a namespace that's simply never loaded; it does **not** block `atom`,
  `read-string`, or ns-mutation fns at the language level (see above) — those are left
  unenforced deliberately rather than papered over with a false sense of restriction.
- **Resource limits via watchdog, not fuel**: cljrs has no interpreter fuel metering
  today. Instead, every `:compute`/`:logic`/`:install` invocation carries a deadline
  (e.g. 2s; generation smoke tests 5s). On timeout the shell **terminates that
  calculator's worker**, reports "computation too expensive" on its card, and spins up
  a replacement worker for *that calculator only* re-eval'd from its own stored source
  — other installed calculators are in other workers and are completely unaffected.
  Memory bombs are similarly bounded: one worker dies, the tab and every other
  calculator survive.
  - Upstream nice-to-have: fuel/step budgets in the cljrs interpreter would make
    termination surgical (fail one call instead of recycling the worker). File the
    issue early; don't block on it.
- **Determinism**: no clock, no randomness in the sandbox (a `:date` input exists for
  "today"-relative calculators, supplied by the app as an input default instead).
- Worst case, a malicious/buggy generation burns its deadline and produces a wrong
  number — which the logic and source views exist to let users catch.

Worker protocol (all payloads EDN strings, since the eval boundary is string-shaped;
no `:calc-id` in the payload since each worker hosts exactly one calculator):

```
→ {:op :install  :source "(calculator {…})" :deadline-ms 5000}
← {:op :installed :spec {…data parts…}}                    ; or {:op :error :errors […]}
→ {:op :compute  :inputs {…} :deadline-ms 2000}
← {:op :computed :outputs {…}}                             ; or {:op :error :errors […]}
→ {:op :logic    :inputs {…} :outputs {…} :deadline-ms 2000}
← {:op :logic    :steps [{…}]}                             ; or {:op :error :errors […]}
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

- **DOM rendering and UI events don't cross this boundary at all** (§3) — they're
  handled entirely inside the main Repl via `replicant.dom`/`cljrs.dom`, verified
  working in §0. What's left needing the JS boundary is genuinely JS-only: the sandbox
  worker's `postMessage` protocol (§5, built this milestone), and later WebLLM/`fetch`/
  `localStorage` (§8, not built yet).
- **There is no Clojure-level `eval` in this interpreter at all** — verified this
  milestone: `eval` and even fully-qualified `clojure.core/eval` are `unbound symbol`
  in *every* namespace, including an unrestricted one. This isn't a sandbox restriction,
  it just doesn't exist as a callable. It doesn't matter in practice: `Repl.eval(text)`
  from the JS side already does read+eval, so trusted code that needs to evaluate a
  freshly-read form just splices it into the next `.eval()` call as text (e.g.
  `(def installed-calc <source-text>)`) instead of calling a Clojure-level `eval` on an
  already-read form.
- **JS can never call back into a Repl on its own — only poll it.** Since events are
  handled entirely inside the Repl (previous bullet) with no round-trip per click, JS
  has no hook telling it "an effect is now pending." What's actually built (§3's
  `app.core`): actions that need the sandbox queue a plain-data effect into
  `app-state`'s `:effects`; the JS host runs a `requestAnimationFrame` loop calling
  `(app.core/take-effects!)` every frame, performs whatever it finds via
  `sandbox-manager.js`, and reports each result back with a *fresh* `.eval()` call to
  `(app.core/handle-effect-result! {...})`. This works because the Repl's vars/atoms
  persist across separate `.eval()` calls even though `*ns*`-relative resolution
  doesn't (§0) — `handle-effect-result!` is always called fully-qualified.
- **JSON, not EDN, for the string payloads, with one hand-rolled wrinkle.** `app.json/
  ->json` (Clojure→JSON) and `src/host/edn.js`'s `toEdn` (JS→Clojure source) replace the
  EDN-string idea above, because JS can `JSON.parse` natively but has no EDN reader.
  Two things had to be worked around, both found this milestone (§0): `EvalResult.
  result()` always `pr-str`'s its value — including when that value is already the
  JSON string a function like `take-effects!` returns — so the JS side must undo one
  layer of Clojure string-escaping (`unwrapClojureString`) before `JSON.parse`; and
  JSON has no keyword type, so a keyword *value* (not a map key) is marked with a
  plain-ASCII sentinel prefix (`~kw~`, not a control character — a raw control byte in
  a JSON string is invalid JSON and `JSON.parse` rejects it) that `toEdn` strips back
  off into a real keyword literal.
- **Async results ride the same poll loop**, not core.async — effects that complete
  later (sandbox worker replies now; LLM tokens/storage reads later, §8) just show up
  as another `handle-effect-result!` call on a subsequent animation frame. core.async
  remains available inside a Repl for app-internal concurrency but wasn't needed for
  this boundary once polling replaced the "JS reads the same call's result back"
  design originally sketched here.
- **Upstream wishlist** (file early, adopt as released, none blocking): structured
  JSON/JS-value results on `EvalResult` (would remove the `pr-str`-unwrap step and the
  keyword-marker hack entirely); a host-function registration hook so the shell can
  expose `fetch`/DOM as capabilities to the *main* Repl only (would remove the need to
  poll); interpreter fuel budgets (§5). The cljrs release cadence is fast (0.1.194→
  0.1.219 within this project's lifetime so far), so expect to ride versions and re-pin
  frequently; the golden suite (§11) is the re-pin gate.

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
  matching; a plain `<textarea>` is the stand-in built in milestone 2.
- **Apply** runs the install path of §5/§6 (symbol scan → eval → validate → smoke
  test, no LLM involved) on the edited text via the same sandbox worker protocol
  generated code uses. Errors show inline (currently a single joined message; line/col
  from the reader is a nice-to-have, not built) and the calculator keeps running its
  last-good source/spec/outputs until an edit actually succeeds.
- **Revert**, as built in milestone 2, discards unapplied edits: it resets the draft
  textarea back to the currently-installed (last-good) source and clears the error.
  Multi-step "undo past a *successful* apply" via a `:history` stack is a nice-to-have
  not built yet — not needed until the library/persistence work in milestone 5.
- An "edited" badge appears on calculators whose source no longer matches the original
  generation, with a diff view (nice-to-have) and "regenerate from description" escape
  hatch.

---

## 10. Repository layout

```
/doc/plan.md                  this document
/vendor/replicant/            vendored replicant .cljc sources for the :rust backend,
                              patched for cljrs-wasm bundling (see NOTES.md, §3)
/src/app/                     Clojurust app core (.cljrs, eval'd into main Repl at boot)
  json.cljrs                  data<->JSON string codec (§7); bundled into main *and*
                              sandbox Repls -- the only cross-wasm-boundary contract
  contract.cljrs              calculator spec + validator + symbol scan + formatters
                              (§4/§6); bundled into main *and* sandbox Repls
  render.cljrs                views (hiccup): calculator card, logic/source panels
  core.cljrs                  entry, state atom, dispatch!, :effects queue drained by
                              the JS host's poll loop (§7), handle-effect-result!
  genpipe.cljrs               generation orchestration, prompts, repair loop (not built
                              yet -- milestone 3)
  backend.cljrs               ModelBackend protocol + webllm/hosted impls (not built
                              yet -- milestone 3/4)
  storage.cljrs               localStorage persistence, share links (not built yet --
                              milestone 5)
/src/sandbox/                 sources eval'd into each calculator's own sandbox Repl
                              (one worker per calculator, §5) -- never core.async,
                              cljrs.dom, or replicant; see build/bundle.mjs's
                              SANDBOX_ORDER
  protocol.cljrs              check-source/finish-install!/compute!/logic! op handlers,
                              called by src/host/sandbox-worker.js
  env.cljrs                   the `calculator` constructor; loaded *last* in the
                              sandbox bundle so it's the active namespace when
                              calculator source text is eval'd (§5)
/src/host/                    JS shell: cljrs-wasm boot for the main Repl (main.js),
                              the sandbox worker script (sandbox-worker.js) and the
                              main-thread manager that owns one per calculator with the
                              watchdog deadline (sandbox-manager.js), the data<->Clojure
                              source codec (edn.js, §7's counterpart to app.json) --
                              webllm glue/editor mount not built yet (milestone 3/4/5)
/build/wasm-shell/            thin Rust crate (`cljrs-wasm` dependency, pinned version)
                              wasm-pack'd to produce the Repl bindings; the *same* pkg
                              is used to boot both the main Repl and every sandbox
                              worker's Repl (just two separate `new Repl()` calls into
                              the same wasm module); see §0 for the `wasm-opt = false`
                              build note
/proxy/                       hosted-model API proxy (serverless function)
/prompts/                     system prompt + few-shot examples (data, versioned)
/test/e2e/                    Playwright end-to-end tests (real browser, real wasm, no
                              mocks): walking-skeleton.mjs (boot/render/recompute
                              through the sandbox), source-editing.mjs (logic panel +
                              apply/revert), watchdog.mjs (a hung :compute trips the
                              deadline and the calculator keeps working after)
/build/                       build/bundle.mjs concatenates two separate bundles into
                              `dist/`: `bundle.cljrs` (vendored replicant + app, for the
                              main Repl) and `sandbox-bundle.cljrs` (json + contract +
                              sandbox/*, for every sandbox worker's Repl) -- both
                              alias-patched per §3; build/build-wasm.sh + dev server
```

Every `.cljrs` file bundled into a Repl this way (app, sandbox, and vendored replicant
alike) follows the §3 bundling rule: only `ns`-form-per-file plus `(alias 'x 'y)` for
sibling namespaces already brought into existence earlier in the same bundle, never
`:require` for them. `:require` is reserved for genuine embedded stdlib namespaces.

---

## 11. Testing strategy

- **Unit** (pure Clojurust; run under native `cljrs test` for speed, same sources as
  wasm): contract validator, symbol scan, formatters, reducers, hiccup differ
  (DOM-op output as data), sandbox env construction (assert banned symbols resolve to
  nothing). Not built yet — milestone 2 tested the contract only end-to-end through the
  browser e2e suite below, since that already exercises the real interpreter (unit
  tests against a native `cljrs test` would need a second run target and were cut for
  this milestone's scope).
- **Golden calculators**: a set of hand-written contract-conforming calculators
  (mortgage, BMI, tip split, date diff, unit conversion) exercised end-to-end —
  install → compute → input change → recompute → logic panel contents. Doubles as the
  **cljrs version re-pin gate**: run against each new cljrs-wasm release before
  adopting it, catching stdlib gaps/regressions like those hit by the replicant port.
  Only the tip calculator is built so far (as the golden/demo calculator in
  `app.core/golden-calculator-source`, exercised by `test/e2e/walking-skeleton.mjs` and
  `source-editing.mjs`); the rest of the set is a milestone-3+ nice-to-have once
  generation exists and there's more than one hand-written calculator worth pinning
  against.
- **Sandbox behavior** (browser, built this milestone): `test/e2e/watchdog.mjs` installs
  a calculator whose `:compute` hangs above a threshold input, confirms the watchdog
  deadline trips, the worker is killed and replaced, no uncaught page error results, and
  the calculator keeps computing correctly afterwards.
- **Generation eval suite** (run on demand, not in CI-critical path): ~40 real prompts
  across domains; measure per-backend pass rate through the §6 pipeline, repair-loop
  attempt counts, and smoke-test numeric sanity. This suite decides the default WebLLM
  model and catches prompt regressions. Not built yet — needs the generation pipeline
  (milestone 3) to exist first.
- **Browser e2e** (Playwright, built this milestone): `walking-skeleton.mjs` (boot →
  install through the real sandbox worker → render → input → recompute),
  `source-editing.mjs` (show logic → real intermediate values; show source → edit with
  a deliberate contract violation → inline error + last-good calculator keeps running →
  revert → edit again with valid code → it actually replaces the running calculator),
  `watchdog.mjs` (above). All three drive the real wasm module and a real Worker, no
  mocked backend — there's no LLM backend to mock yet (that's milestone 3).

---

## 12. Milestones

1. **Walking skeleton** — shell boots cljrs-wasm, evals the vendored replicant bundle
   plus bundled app sources into the main Repl; `replicant.dom/render` renders a
   hand-written calculator's hiccup and `set-dispatch!` wires input/click events back
   into an app-state atom; inputs recompute outputs (in-main-Repl for now). *Proves the
   boot/eval/render/dispatch stack before any sandbox or LLM work.*
2. **Sandbox + contract** — ✅ done. One sandbox Repl per calculator in its own Web
   Worker (§5's revised architecture) with the install/compute/logic protocol and a
   verified watchdog (deadline → `Worker.terminate()` → respawn → reinstall last-good
   source); the §4 contract's symbol scan, spec validator, and smoke test; the closed
   formatter set; textarea source editing with apply/revert. Scope actually built: a
   single calculator (the tip calculator, now installed through the real sandbox
   pipeline instead of milestone 1's in-main-Repl `:compute`) rather than a
   multi-calculator library — the `:calculators` map from §3 and a home screen are
   still just a shape, not wired up, since there's no generation yet to populate more
   than one. *The app is now fully useful with pasted code.*
3. **Hosted generation** — proxy function, streaming, full pipeline with repair loop;
   logic panel. *First end-to-end "describe → calculator" moment.*
4. **WebLLM backend** — model download UX, backend picker, eval suite to pick the
   default model, tune prompts/repair for the small model.
5. **Polish** — CodeMirror editor, library/persistence, share links, refine prompts,
   edited-badge/diff, trust framing, mobile layout.
6. **Hardening** — allowlist/watchdog audit, rate limiting on the proxy, generation
   eval regression run, cross-browser (WebGPU matrix) pass, wasm size budget
   (interpreter + embedded IR bundles; measure at milestone 1, wasm-opt + brotli).

---

## 13. Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| cljrs stdlib gaps / fast-moving releases (`declare`, `run!`, `some->>` recently missing; 0.1.194→219 in days) | Generated & app code breaks on version bumps | Pin cljrs-wasm; golden-calculator suite as re-pin gate; banned-forms list in prompt + symbol scan |
| `:require` cannot load a sibling namespace defined only by an earlier `eval` in the same session (no filesystem/source-path in cljrs-wasm) | Breaks any multi-namespace `.cljrs` bundle written with normal `:require` | Verified fix: use `(alias 'x 'y)` for intra-bundle namespace references instead of `:require` (§3); applies to app/sandbox/vendored-replicant sources alike |
| `reify` method-parameter-shadows-protocol-method-name interpreter bug | Silent `WrongType` errors in any `reify` whose param name collides with the method name | Verified workaround: rename the shadowing parameter (done in vendored `replicant.dom`); file upstream; watch for the same pattern in new code |
| `(:refer-clojure :only [])` doesn't hide `NativeFn`-tier bindings (`atom`, `read-string`, `ns`, `intern`, `require`, …); `ns-unmap` doesn't exist | No real language-level allowlist for sandboxed calculator code | Worker isolation is the actual boundary (§5); one Repl per calculator so a calc can't reach another's namespace even via `in-ns`/`intern`; only load `clojure.core` + sandbox sources into the sandbox bundle so unreachable namespaces (`core.async`, `cljrs.dom`) fail with "no such namespace" regardless of refers |
| String-only eval results | Clunky interop, perf overhead, but now only affects the (smaller) surface left after §3 — sandbox worker + LLM/storage/fetch effects | EDN-over-strings protocol (§7); batch event dispatches; upstream structured-result request |
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
