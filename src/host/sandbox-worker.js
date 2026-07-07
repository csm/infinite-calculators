// Runs inside a dedicated Web Worker, one per installed calculator (see
// doc/plan.md §5). Boots its own cljrs-wasm Repl -- separate wasm instance
// and separate JS global scope from the main thread, with no fetch/DOM/
// storage reachable from a worker regardless of what Clojure code does --
// and evals only the sandbox bundle (clojure.core plus src/sandbox/*.cljrs,
// no core.async/cljrs.dom/replicant) into it. Deadlines are NOT enforced in
// here: a truly non-yielding loop can't be preempted from inside its own
// thread. Enforcement is the owning side's job (sandbox-manager.js), via
// Promise.race + Worker.terminate(), which was verified to reliably kill
// even a tight infinite loop (doc/plan.md §5).
import init, { Repl } from '/build/wasm-shell/pkg/infinite_calculators_wasm_shell.js';
import { toClojureString, toEdn, unwrapClojureString } from './edn.js';

let repl = null;
let bundleTextPromise = null;

async function ensureRepl() {
  if (repl) return repl;
  await init();
  repl = new Repl();
  if (!bundleTextPromise) {
    bundleTextPromise = fetch('/dist/sandbox-bundle.cljrs').then((r) => r.text());
  }
  const bundleText = await bundleTextPromise;
  const r = await repl.eval(bundleText);
  if (r.is_error) throw new Error('sandbox bundle eval failed: ' + r.result);
  return repl;
}

function parseSandboxResponse(evalResult) {
  if (evalResult.is_error) {
    return { ok: false, errors: [{ message: evalResult.result }] };
  }
  try {
    return JSON.parse(unwrapClojureString(evalResult.result));
  } catch (err) {
    return { ok: false, errors: [{ message: 'bad response from sandbox: ' + evalResult.result }] };
  }
}

async function handle({ op, source, inputs, outputs }) {
  const r = await ensureRepl();
  switch (op) {
    case 'install': {
      const scan = parseSandboxResponse(await r.eval(`(sandbox.protocol/check-source ${toClojureString(source)})`));
      if (!scan.ok) return scan;
      // Each separate repl.eval() call resets unqualified symbol resolution
      // to a default namespace even though *ns* still reports the last one
      // set (verified: (ns-name *ns*) says sandbox.env, but a bare
      // `calculator` symbol is still "unbound" without this) -- so every
      // call that needs `calculator` to resolve unqualified, as the §4
      // contract requires calculator source to use it, must re-establish
      // the namespace itself first.
      return parseSandboxResponse(
        await r.eval(`(in-ns 'sandbox.env)\n(def installed-calc ${source})\n(sandbox.protocol/finish-install! installed-calc)`),
      );
    }
    case 'compute':
      return parseSandboxResponse(await r.eval(`(sandbox.protocol/compute! ${toEdn(inputs)})`));
    case 'logic':
      return parseSandboxResponse(await r.eval(`(sandbox.protocol/logic! ${toEdn(inputs)} ${toEdn(outputs)})`));
    default:
      return { ok: false, errors: [{ message: `unknown op: ${op}` }] };
  }
}

// Requests are processed one at a time: a single Repl instance isn't safe
// to call `.eval()` on concurrently, and this worker only ever serves one
// calculator anyway, so there's never a reason to overlap them.
let queue = Promise.resolve();

self.onmessage = (e) => {
  const { reqId } = e.data;
  queue = queue
    .then(() => handle(e.data))
    .catch((err) => ({ ok: false, errors: [{ message: String((err && err.message) || err) }] }))
    .then((response) => self.postMessage({ reqId, ...response }));
};
