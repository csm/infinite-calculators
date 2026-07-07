# Infinite Calculators

On-demand calculators generated from a natural-language description, running entirely
in the browser on **Clojurust** via **cljrs-wasm**. See [`doc/plan.md`](doc/plan.md) for
the full design.

This is milestone 3 (**hosted generation**): describing a calculator in plain English
streams a generation from a hosted LLM through a small proxy, extracts and symbol-scans
the resulting source, and installs it through the same sandbox pipeline milestone 2
built (eval → validate → smoke test). A failed attempt is repaired automatically (the
specific validator/smoke-test error is fed back to the model, up to two retries) before
giving up with a friendly error — the calculator that was already running is never
disturbed by a failed generation. Milestone 2's textarea source editor still works the
same way on whatever gets installed, generated or hand-written.

**Not yet run end-to-end in this repo's CI/dev environment**: building `wasm-shell`
needs a network path to crates.io's download CDN that this session's sandbox didn't
have, so `npm run test:e2e` (including the new `test/e2e/generation.mjs`) hasn't
actually executed against this milestone's code yet. See doc/plan.md §13's "milestone
3" open questions before treating it as verified.

## Setup

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install
npm run build   # builds build/wasm-shell (wasm-pack) and dist/{bundle,sandbox-bundle}.cljrs
npm run dev     # serves the repo root; open /src/host/index.html
```

`npm run build:wasm` disables `wasm-opt` (see `build/wasm-shell/Cargo.toml`) because
some sandboxed environments can't reach the binaryen release download it needs; drop
that line for a real production build, or run `wasm-opt` as a separate step.

### Hosted generation proxy

Generation needs `proxy/server.mjs` running somewhere the browser app can reach (see
`src/host/generation-client.js` — it posts to `window.GENERATE_ENDPOINT`, defaulting to
same-origin `/api/generate`, so deploying the proxy behind the same host/reverse-proxy
as the static site needs no client config; deploying it elsewhere means setting that
global before `main.js` loads):

```sh
export ANTHROPIC_API_KEY=sk-ant-...
npm run proxy:dev   # listens on :8787 by default (PORT env var)
```

`proxy/prompts.mjs` assembles the system prompt and few-shot examples from `/prompts/`
server-side — the client never sends or overrides them (doc/plan.md §13). The proxy is
provider-agnostic (`proxy/providers/anthropic.mjs`); swapping providers means adding
another module with the same `streamCompletion({apiKey, model, system, messages})`
async-generator shape and pointing `GENERATION_PROVIDER` at it.

## Layout

- `vendor/replicant/` — vendored, patched replicant sources for the `:rust` DOM
  backend (see `vendor/replicant/NOTES.md` for why they're patched and how to
  re-vendor).
- `build/wasm-shell/` — thin Rust crate pinning `cljrs-wasm`, built with `wasm-pack`.
  The same built package boots both the main Repl and every sandbox worker's Repl.
- `build/bundle.mjs` — concatenates two bundles into `dist/`: `bundle.cljrs` (vendored
  replicant + `src/app/*.cljrs`, for the main Repl) and `sandbox-bundle.cljrs`
  (`app.json`/`app.contract` + `src/sandbox/*.cljrs`, for every sandbox worker's Repl —
  deliberately never `core.async`/`cljrs.dom`/replicant, see `doc/plan.md` §5). See
  `doc/plan.md` §3 for why bundling is flat concatenation rather than per-file
  `:require`.
- `src/app/` — the trusted app, in Clojurust, eval'd into the main Repl at boot.
  `json.cljrs`/`contract.cljrs` are shared with the sandbox bundle (see above).
  `genpipe.cljrs` is the generation pipeline's pure text-extraction/attempt-tracking
  helpers; the state machine itself lives in `core.cljrs`'s `:generation` key and
  `handle-effect-result!` cases.
- `src/sandbox/` — code eval'd into each calculator's own sandbox Repl: the
  `calculator` constructor and the install/compute/logic op handlers a worker calls.
- `src/host/` — the JS shell. `main.js` boots the main Repl and runs the effect poll
  loop (Clojure can't call back into JS on its own, see `doc/plan.md` §7);
  `sandbox-worker.js` is what runs inside each calculator's Worker;
  `sandbox-manager.js` owns those workers from the main thread and enforces the
  watchdog deadline; `generation-client.js` streams a generation from the proxy and
  parses its SSE response; `edn.js` is the data⇄Clojure-source codec for the JS side
  of the sandbox/JSON boundary (`app.json` is the Clojure side).
- `prompts/` — the versioned system prompt (`system.md`) and few-shot examples
  (`examples.json`) the proxy assembles into the model request. Never sent by or
  editable from the client.
- `proxy/` — the hosted-generation proxy (`server.mjs`), prompt assembly
  (`prompts.mjs`), and provider implementations (`providers/anthropic.mjs` real,
  `providers/fake.mjs` for the e2e test).

## Testing

```sh
npm run build
npm run test:e2e
```

Runs four real Chromium sessions (Playwright) against the built app — same code paths
a user hits, no mocks except the LLM itself (there's no real API key or model access in
CI, so `generation.mjs` runs the real proxy against a scripted fake provider instead;
see `proxy/providers/fake.mjs`):

- `test/e2e/walking-skeleton.mjs` — boot, install the demo calculator through the real
  sandbox worker, change an input, assert the output recomputes correctly.
- `test/e2e/source-editing.mjs` — the logic panel shows real computed values; editing
  the source with a contract violation shows an inline error and leaves the last-good
  calculator running; Revert restores the editor; a valid edit actually replaces the
  running calculator.
- `test/e2e/watchdog.mjs` — a calculator whose `:compute` hangs for certain inputs trips
  the deadline, its worker gets killed and replaced, and the calculator keeps working
  afterwards.
- `test/e2e/generation.mjs` — a description streams through the real proxy and installs
  through the real sandbox pipeline on the first attempt; a scripted bad first attempt
  is repaired automatically and still ends up installed; a scripted always-bad attempt
  exhausts its retries and surfaces a friendly error without disturbing the calculator
  already running.

## Deployment

`.github/workflows/deploy.yml` builds the app and uploads it to a static SFTP host on
every push to `main` (or manually via workflow_dispatch). It stages only the
runtime-required files — `dist/`, `build/wasm-shell/pkg/`, `src/host/` — into `deploy/`
(`npm run prepare-deploy`; see `build/prepare-deploy.mjs`), plus a generated `index.html`
that redirects the site root to `/src/host/index.html` (the app's real entry point,
whose relative script/style tags mean it has to be served from that path).

Add these repo secrets (Settings → Secrets and variables → Actions) for the workflow to
authenticate:

- `SFTP_SERVER` — hostname or IP
- `SFTP_PORT` — usually `22`
- `SFTP_USERNAME`
- `SFTP_PASSWORD`
- `SFTP_REMOTE_PATH` — the remote directory to upload into (e.g. your web root)
