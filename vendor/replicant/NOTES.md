# Vendored replicant sources

Source: https://github.com/csm/replicant, `main` @ `551be1fd999242d081af5a57e0f71ad6c6c451ca`
(fetched 2026-07-07).

Only the files needed for the `:rust` DOM renderer backend are vendored — not all of
`src/replicant/`. Upstream files not needed here (`env.clj`, `env.cljs`, `mutation_log.cljc`,
`string.cljc`) are the cljs-compiler dev-key bridge, the string-rendering backend, and a
JVM/JS-only mutation logger; none of them are on the `:rust` path.

## Why these are patched, not used verbatim

cljrs-wasm's `Repl` has no filesystem or source path, so `eval`-ing a file's `(ns ...)`
form makes that namespace *exist* but never marks it "loaded" the way a real
`require`/classpath search would. Any later `:require` of that namespace — even in the
same `eval` call, even though the namespace is right there — fails with
`Could not find namespace ... on source path`. This is true for our own bundled
namespaces just as much as for `cljrs.dom` (natively registered without ever going
through an `ns` form), which is the case the upstream `dom.cljc` comments already call
out. See `doc/plan.md` §0/§3 for how this was verified.

Two mechanical patches were applied to every vendored file, on top of the pristine
upstream text:

1. **Every intra-bundle `:require` became a post-`ns` `(alias 'x 'the.other.ns)` call.**
   `:require` is kept only for genuine embedded stdlib namespaces (`clojure.string`,
   `clojure.walk` — both confirmed present in cljrs-wasm 0.1.219). Reader-conditional
   requires that never apply under `:rust` (e.g. `#?(:clj [replicant.env :as env])`,
   `#?(:cljs (:require-macros ...))`) were simply dropped, since they were dead text
   under this target anyway.
2. **`dom.cljc`: renamed one `reify` method parameter.** The `:rust` `create-renderer`'s
   `replace-child` implementation was `(replace-child [this el insert-child
   replace-child] (dom/replace! replace-child insert-child) this)` — the 4th parameter
   shares its name with the protocol method itself. cljrs has a `reify` bug where this
   doesn't shadow correctly: the body resolved the *outer* protocol fn (a value of type
   `fn`), not the local `DomNode` argument, producing
   `WrongType: expected DomNode, got fn`. Renamed the parameter to `old-child`. Filed as
   an upstream cljrs issue; watch for the same shadowing pattern in any new reify code.

No other changes were made. Diff each file against the pinned commit above before
re-vendoring to confirm only these two patch classes still apply — if either the
`:require`-on-a-live-namespace behavior or the `reify` shadowing bug are fixed upstream
in cljrs, the corresponding patch here becomes unnecessary (but harmless to leave).

## Re-vendoring on a replicant update

```
commit=<new upstream commit>
base=https://raw.githubusercontent.com/csm/replicant/$commit/src/replicant
for f in protocols hiccup hiccup_headers vdom console_logger assert asserts errors \
         transition core alias dom; do
  curl -sSf "$base/$f.cljc" -o "vendor/replicant/$f.cljc"
done
```

Then reapply the two patch classes above (search each file's original `ns` form for
`:require [replicant.` clauses and convert to `alias`; check `dom.cljc`'s
`replace-child` reify method for the parameter-name collision) and re-run the browser
verification harness before bumping the pin.

## Bundle order

These files must be `eval`'d in this order (dependency order, respecting the `alias`
patch above): `protocols`, `hiccup`, `hiccup_headers`, `vdom`, `console_logger`,
`assert`, `asserts`, `errors`, `transition`, `core`, `alias`, `dom`. See
`build/bundle.mjs`.
