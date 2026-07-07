# Infinite Calculators

On-demand calculators generated from a natural-language description, running entirely
in the browser on **Clojurust** via **cljrs-wasm**. See [`doc/plan.md`](doc/plan.md) for
the full design.

This is milestone 2 (**sandbox + contract**): a calculator's `:compute`/`:logic` run in
a dedicated Web Worker, one per calculator, each hosting its own cljrs-wasm Repl. The
worker's install path runs the calculator contract's validator, symbol scan, and smoke
test before anything is trusted; a watchdog deadline kills and respawns a worker that
hangs. The demo calculator (tip splitting) is installed through this real pipeline
rather than computed in the main Repl, and its source can be edited live (textarea,
Apply/Revert) through the same pipeline pasted/generated code will use once generation
exists (milestone 3). There's still no LLM — that's next.

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
- `src/sandbox/` — code eval'd into each calculator's own sandbox Repl: the
  `calculator` constructor and the install/compute/logic op handlers a worker calls.
- `src/host/` — the JS shell. `main.js` boots the main Repl and runs the effect poll
  loop (Clojure can't call back into JS on its own, see `doc/plan.md` §7);
  `sandbox-worker.js` is what runs inside each calculator's Worker;
  `sandbox-manager.js` owns those workers from the main thread and enforces the
  watchdog deadline; `edn.js` is the data⇄Clojure-source codec for the JS side of that
  boundary (`app.json` is the Clojure side).

## Testing

```sh
npm run build
npm run test:e2e
```

Runs three real Chromium sessions (Playwright) against the built app, no mocks — same
code paths a user hits:

- `test/e2e/walking-skeleton.mjs` — boot, install the demo calculator through the real
  sandbox worker, change an input, assert the output recomputes correctly.
- `test/e2e/source-editing.mjs` — the logic panel shows real computed values; editing
  the source with a contract violation shows an inline error and leaves the last-good
  calculator running; Revert restores the editor; a valid edit actually replaces the
  running calculator.
- `test/e2e/watchdog.mjs` — a calculator whose `:compute` hangs for certain inputs trips
  the deadline, its worker gets killed and replaced, and the calculator keeps working
  afterwards.

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
