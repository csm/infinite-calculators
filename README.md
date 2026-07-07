# Infinite Calculators

On-demand calculators generated from a natural-language description, running entirely
in the browser on **Clojurust** via **cljrs-wasm**. See [`doc/plan.md`](doc/plan.md) for
the full design.

This is milestone 1 (the "walking skeleton"): a hand-written calculator proving the
boot → eval → render → dispatch → recompute loop, with no LLM or sandbox yet.

## Setup

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install
npm run build   # builds build/wasm-shell (wasm-pack) and dist/bundle.cljrs
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
- `build/bundle.mjs` — concatenates the vendored replicant sources and `src/app/*.cljrs`
  into `dist/bundle.cljrs` in dependency order (see `doc/plan.md` §3 for why this is a
  flat concatenation rather than per-file `:require`).
- `src/app/` — the app itself, in Clojurust, eval'd into the main Repl at boot.
- `src/host/` — the JS shell: boots cljrs-wasm, evals the bundle, and does nothing else
  (rendering and event dispatch happen entirely inside Clojurust via `replicant.dom`).

## Testing

```sh
npm run build
npm run test:e2e
```

Runs a real Chromium session (Playwright) against the built app: boots the wasm module,
checks the calculator renders, changes an input, and asserts the outputs recompute
correctly. No mocks — this is the same code path a user hits.
