// JS host shell (doc/plan.md §2): boots cljrs-wasm, evals the bundled sources
// into the main Repl, hands off to the app's boot! function, then owns every
// subsequent entry into that Repl: delegated DOM events and effect results
// both arrive as eval'd calls into app.core, and the effects the app queues
// (sandbox worker protocol §5, hosted generation §6) are drained right after
// any eval that could have queued them -- this interpreter has no way for
// Clojure code to call back into JS on its own (§7), so JS has to come
// collect pending effects rather than being handed them.
//
// Two hard rules, both learned from real-device failures (doc/plan.md's
// milestone-3 notes):
//
// 1. Exactly ONE entry into the main Repl at a time. cljrs-wasm's eval()
//    yields to the browser event loop before its Promise resolves while
//    still holding a RefCell borrow on interpreter state, so any *other*
//    entry into the same Repl during that window -- a second eval(), or a
//    native cljrs.dom event listener firing on a real click/keystroke --
//    panics with "already borrowed" and aborts to a wasm trap. Worse than
//    the error itself: a trap mid-replicant-render leaves replicant's
//    internal :rendering? flag stuck, after which every later render
//    silently queues forever and the UI never updates again (observed as a
//    half-updated page that ignores newly installed calculators). So every
//    eval goes through serializedEval() below, and the app renders NO
//    native event handlers at all: hiccup carries data-action attributes
//    (app.render), and the delegated listeners here feed them through the
//    same serialized queue as everything else.
//
// 2. The Repl does no work at idle. Effects can only be queued by an eval
//    this file itself initiates (dispatch!, handle-effect-result!, boot!),
//    so draining after each of those is complete coverage -- there is no
//    fixed-interval poll loop. The previous design polled take-effects!
//    forever (60Hz at first, then 100ms, then 500ms as mobile Safari kept
//    crash-looping over the sustained background CPU/memory pressure); all
//    of that idle interpreter churn is gone, not just rarer.
import init, { Repl } from '/build/wasm-shell/pkg/infinite_calculators_wasm_shell.js';
import { sandbox } from './sandbox-manager.js';
import { streamGenerate } from './generation-client.js';
import { toClojureString, toEdn, unwrapClojureString } from './edn.js';

let repl = null;

// Rule 1: a single promise chain through which every eval on the main Repl
// flows, so no two can ever be in flight together.
let evalChain = Promise.resolve();
function serializedEval(code) {
  const run = evalChain.then(() => repl.eval(code));
  evalChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function reportEffectResult(payload) {
  const call = `(app.core/handle-effect-result! ${toEdn(payload)})`;
  const r = await serializedEval(call);
  if (r.is_error) console.error('handle-effect-result! failed', r.result, call);
  await drainEffects();
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
async function runGenerateEffect(effect) {
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
      await reportEffectResult({ kind: 'generate-done', 'request-id': requestId, text: result.text });
    } else if (result.text && result.text.trim()) {
      // The stream failed *after* producing text -- most commonly the
      // provider's max_tokens truncation signal, which arrives at the very
      // end of the stream. That text often still contains a complete
      // calculator (the model finished the fenced block, then got cut off
      // adding prose after it), so hand it to the normal extract/scan
      // pipeline instead of failing outright; app.core only surfaces the
      // stream error if the extracted source doesn't scan as one complete
      // form.
      await reportEffectResult({
        kind: 'generate-done',
        'request-id': requestId,
        text: result.text,
        'stream-error': result.error,
      });
    } else {
      await reportEffectResult({ kind: 'generate-error', 'request-id': requestId, message: result.error });
    }
  } catch (err) {
    await reportEffectResult({
      kind: 'generate-error',
      'request-id': requestId,
      message: String((err && err.message) || err),
    });
  }
}

async function runEffect(effect) {
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
  await reportEffectResult(payload);
}

// Rule 2: drain on demand, never on a timer. The draining/drainRequested
// pair coalesces overlapping requests -- a drain asked for while one is
// already running just makes the running loop take one more lap, so effects
// queued by an eval that completed mid-drain are still picked up.
let draining = false;
let drainRequested = false;

async function drainEffects() {
  drainRequested = true;
  if (draining) return;
  draining = true;
  try {
    while (drainRequested) {
      drainRequested = false;
      const r = await serializedEval('(app.core/take-effects!)');
      if (r.is_error) {
        console.error('take-effects! failed', r.result);
        return;
      }
      let effects = [];
      try {
        effects = JSON.parse(unwrapClojureString(r.result));
      } catch (err) {
        console.error('malformed effects payload', r.result);
      }
      for (const effect of effects) {
        if (effect.kind === 'generate') {
          // A generation streams for seconds; don't hold the sandbox
          // effects behind it (typing into the already-running calculator
          // keeps recomputing while a new one streams). Its done/error
          // report re-enters through reportEffectResult -> drainEffects
          // like everything else.
          runGenerateEffect(effect).catch((err) => console.error('generate effect failed', err));
        } else {
          await runEffect(effect);
        }
      }
    }
  } finally {
    draining = false;
  }
}

// Delegated DOM events -> app.core/dispatch! evals. Bursts on the same
// control are coalesced (each keystroke would otherwise queue its own
// eval+render round trip while only the final value matters), but distinct
// actions are never reordered.
const pendingDispatches = [];
let pumping = false;

function queueDispatch(actionEdn, value) {
  const last = pendingDispatches[pendingDispatches.length - 1];
  if (last && last.actionEdn === actionEdn && last.value !== null && value !== null) {
    last.value = value;
  } else {
    pendingDispatches.push({ actionEdn, value });
  }
  pumpDispatches();
}

async function pumpDispatches() {
  if (pumping) return;
  pumping = true;
  try {
    while (pendingDispatches.length > 0) {
      const { actionEdn, value } = pendingDispatches.shift();
      const call = `(app.core/dispatch! ${actionEdn} ${value === null ? 'nil' : toClojureString(value)})`;
      const r = await serializedEval(call);
      if (r.is_error) console.error('dispatch! failed', r.result, call);
      await drainEffects();
    }
  } finally {
    pumping = false;
  }
}

// The app's hiccup carries no event handlers (rule 1): every interactive
// element declares a data-action attribute (see app.render) whose value is
// the dispatch action as EDN text, spliced verbatim into the dispatch!
// call -- it only ever comes from our own render code, never from
// generated-calculator data (titles/labels render as text nodes). Buttons
// act on click, text-y controls on input, selects on change; disabled
// controls fire none of these, so busy-state gating stays in the hiccup.
function attachEventDelegation(rootEl) {
  rootEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && el.tagName === 'BUTTON') queueDispatch(el.dataset.action, null);
  });
  rootEl.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.action && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      queueDispatch(el.dataset.action, el.value);
    }
  });
  rootEl.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.action && el.tagName === 'SELECT') {
      queueDispatch(el.dataset.action, el.value);
    }
  });
}

async function main() {
  await init();
  repl = new Repl();

  // These two evals happen before any listener is attached, so they can't
  // race anything -- no need for serializedEval yet.
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

  attachEventDelegation(document.getElementById('app'));
  await drainEffects(); // boot! queued the golden calculator's install
}

main();
