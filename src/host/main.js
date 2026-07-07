// JS host shell (doc/plan.md §2): boots cljrs-wasm, evals the bundled sources
// into the main Repl, hands off to the app's boot! function, then runs a
// poll loop draining effects the app queues for work only JS can do (the
// sandbox worker protocol, §5) -- this interpreter has no way for Clojure
// code to call back into JS on its own (§7), so JS has to come collect
// pending effects rather than being handed them.
import init, { Repl } from '/build/wasm-shell/pkg/infinite_calculators_wasm_shell.js';
import { sandbox } from './sandbox-manager.js';
import { streamGenerate } from './generation-client.js';
import { toEdn, unwrapClojureString } from './edn.js';

async function reportEffectResult(repl, payload) {
  const call = `(app.core/handle-effect-result! ${toEdn(payload)})`;
  const r = await repl.eval(call);
  if (r.is_error) console.error('handle-effect-result! failed', r.result, call);
}

// The "generate" effect (doc/plan.md §6/§8) is the one effect that reports
// back more than once -- a final done/error, plus live progress while
// streaming -- instead of a single awaited outcome like install/compute/
// logic below, so it can't go through the generic runEffect/single-report
// path. The live progress text is written straight to the DOM
// (.generation-partial, rendered once, empty, by app.render when :generation
// :status enters :streaming) instead of round-tripping through a Repl call
// per chunk: a multi-second stream was calling repl.eval() every ~80ms with
// an ever-larger embedded string, which was real, unbounded-feeling memory/
// CPU churn on the main Repl and was crashing real mobile Safari sessions
// mid-stream. This is purely cosmetic (doc/plan.md §6's "dimmed source
// scrolling by"), so it doesn't need the interpreter at all -- only the
// final `generate-done`/`generate-error` result (one call, not dozens)
// needs to reach app.core to drive the real pipeline.
async function runGenerateEffect(repl, effect) {
  const requestId = effect['request-id'];
  // Clear any text left over from a prior attempt (e.g. a repair retry) --
  // replicant never touches this node's content itself now (the hiccup
  // value driving it is always ""), so nothing else will.
  const previewEl = document.querySelector('.generation-partial');
  if (previewEl) previewEl.textContent = '';
  try {
    const result = await streamGenerate(
      {
        description: effect.description,
        attempt: effect.attempt,
        priorSource: effect['prior-source'],
        priorError: effect['prior-error'],
      },
      (partialText) => {
        const el = document.querySelector('.generation-partial');
        if (el) el.textContent = partialText;
      },
    );
    if (result.ok) {
      await reportEffectResult(repl, { kind: 'generate-done', 'request-id': requestId, text: result.text });
    } else {
      await reportEffectResult(repl, { kind: 'generate-error', 'request-id': requestId, message: result.error });
    }
  } catch (err) {
    await reportEffectResult(repl, {
      kind: 'generate-error',
      'request-id': requestId,
      message: String((err && err.message) || err),
    });
  }
}

async function runEffect(repl, effect) {
  const { kind } = effect;
  const calcId = effect['calc-id'];
  const requestId = effect['request-id'];
  let outcome;
  switch (kind) {
    case 'install':
      outcome = await sandbox.install(calcId, effect.source);
      break;
    case 'compute':
      outcome = await sandbox.compute(calcId, effect.inputs);
      break;
    case 'logic':
      outcome = await sandbox.logic(calcId, effect.inputs, effect.outputs);
      break;
    default:
      return;
  }
  const payload = {
    kind,
    'request-id': requestId,
    'calc-id': calcId,
    ...(kind === 'install' ? { source: effect.source } : {}),
    ...outcome,
  };
  await reportEffectResult(repl, payload);
}

async function main() {
  await init();
  const repl = new Repl();

  const bundleSource = await (await fetch('/dist/bundle.cljrs')).text();
  const bundleResult = await repl.eval(bundleSource);
  if (bundleResult.is_error) {
    document.getElementById('app').textContent =
      `Failed to load app bundle: ${bundleResult.result}`;
    console.error('bundle eval failed', bundleResult.result, bundleResult.output);
    return;
  }

  const bootResult = await repl.eval('(app.core/boot!)');
  if (bootResult.is_error) {
    document.getElementById('app').textContent = `Failed to boot: ${bootResult.result}`;
    console.error('boot failed', bootResult.result, bootResult.output);
    return;
  }

  window.__repl = repl; // dev/debugging convenience only

  // Polls at a fixed cadence rather than every animation frame (60Hz):
  // effects (sandbox install/compute/logic/generate round trips) already
  // take tens of ms to seconds, so added latency here is imperceptible,
  // and a constant eval() call into the interpreter -- even when idle --
  // is real sustained CPU/memory pressure that mobile Safari's per-tab
  // resource watchdog has been observed to crash-loop over ("A Problem
  // Repeatedly Occurred") once real typing/dispatch! activity on the same
  // Repl instance is layered on top of it.
  //
  // Real-world finding, more serious than the above: a native DOM-event
  // callback (a real click/keystroke, dispatched by cljrs.dom/listen!
  // straight into this same Repl, doc/plan.md §3) firing while this poll
  // loop's `repl.eval()` call is still in flight produces a Rust
  // `RefCell` "already borrowed" panic, which aborts to the wasm
  // "unreachable code" trap -- confirmed via a browser stack trace showing
  // both. This means cljrs-wasm's `eval()` yields control back to the
  // browser's event loop at some point before its Promise resolves (only
  // way a DOM event could interleave with it at all, JS being single-
  // threaded) while apparently holding a borrow across that yield --
  // which is a bug in the interpreter's own async implementation, not
  // something fixable from application code. Widening the poll interval
  // only shrinks the window during which this app's own eval() calls can
  // collide with a native one; it does not eliminate the race (a native
  // dispatch! could still overlap a *result-reporting* eval() call after
  // an effect completes, regardless of poll cadence). File upstream against
  // cljrs-wasm if this needs a real fix.
  const POLL_INTERVAL_MS = 500;

  async function tick() {
    try {
      const r = await repl.eval('(app.core/take-effects!)');
      if (!r.is_error) {
        let effects = [];
        try {
          effects = JSON.parse(unwrapClojureString(r.result));
        } catch (err) {
          console.error('malformed effects payload', r.result);
        }
        for (const effect of effects) {
          if (effect.kind === 'generate') await runGenerateEffect(repl, effect);
          else await runEffect(repl, effect);
        }
      } else {
        console.error('take-effects! failed', r.result);
      }
    } catch (err) {
      console.error('effect tick failed', err);
    }
    setTimeout(tick, POLL_INTERVAL_MS);
  }
  setTimeout(tick, POLL_INTERVAL_MS);
}

main();
