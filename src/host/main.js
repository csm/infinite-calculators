// JS host shell (doc/plan.md §2): boots cljrs-wasm, evals the bundled sources
// into the main Repl, and hands off to the app's boot! function. This file
// intentionally does none of the app's logic -- state, rendering, and event
// dispatch all happen inside Clojurust (app.core/app.render), reached only
// through Repl.eval.
import init, { Repl } from '/build/wasm-shell/pkg/infinite_calculators_wasm_shell.js';

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
}

main();
