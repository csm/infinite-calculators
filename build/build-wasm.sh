#!/usr/bin/env bash
# Builds the wasm-shell crate (thin re-export of the pinned cljrs-wasm version,
# see build/wasm-shell/Cargo.toml) into build/wasm-shell/pkg/, consumed by
# src/host/main.js. Requires the wasm32-unknown-unknown target and wasm-pack:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-pack
set -euo pipefail
cd "$(dirname "$0")/wasm-shell"
wasm-pack build --target web --out-dir pkg
