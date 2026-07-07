// JS host shell (doc/plan.md §2): boots cljrs-wasm, evals the bundled sources
// into the main Repl, hands off to the app's boot! function, then runs a
// poll loop draining effects the app queues for work only JS can do (the
// sandbox worker protocol, §5) -- this interpreter has no way for Clojure
// code to call back into JS on its own (§7), so JS has to come collect
// pending effects rather than being handed them.
import init, { Repl } from '/build/wasm-shell/pkg/infinite_calculators_wasm_shell.js';
import { sandbox } from './sandbox-manager.js';
import { toEdn, unwrapClojureString } from './edn.js';

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
  const call = `(app.core/handle-effect-result! ${toEdn(payload)})`;
  const r = await repl.eval(call);
  if (r.is_error) console.error('handle-effect-result! failed', r.result, call);
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
          await runEffect(repl, effect);
        }
      } else {
        console.error('take-effects! failed', r.result);
      }
    } catch (err) {
      console.error('effect tick failed', err);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

main();
