#!/usr/bin/env node
// Milestone-2 source-editing test (doc/plan.md §9/§12): "Show logic" renders
// the live intermediate values the sandboxed :logic fn returns, and
// "Show source" lets the user edit + Apply pasted code through the same
// validate/smoke-test pipeline generated code goes through -- a bad edit
// shows an inline error and leaves the last-good calculator running; Revert
// discards the bad edit; a good edit actually replaces the running
// calculator. Requires `npm run build` to have been run first.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = 8124;

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url).then(() => resolve()).catch((err) => {
        if (Date.now() > deadline) reject(err);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(actual, expected, message) {
  if (!actual.includes(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

const BROKEN_SOURCE = `(calculator
 {:title "Tip calculator"
  :description "Split a bill with a tip."
  :inputs [{:id :bill :label "Bill amount" :type :number :default 50.0 :unit "$"}
           {:id :tip-pct :label "Tip %" :type :number :default 18.0 :unit "%"}]
  :outputs [{:id :tip :label "Tip" :format [:currency "USD"]}
            {:id :total :label "Total" :format [:currency "USD"]}]
  :compute (fn [{:keys [bill tip-pct]}]
             {:tip "not a number" :total (+ bill tip-pct)})
  :logic (fn [in out] [])})`;

const GOOD_SOURCE_V2 = `(calculator
 {:title "Tip calculator v2"
  :description "Split a bill with a tip, v2."
  :inputs [{:id :bill :label "Bill amount" :type :number :default 40.0 :unit "$"}
           {:id :tip-pct :label "Tip %" :type :number :default 10.0 :unit "%"}]
  :outputs [{:id :tip :label "Tip" :format [:currency "USD"]}
            {:id :total :label "Total" :format [:currency "USD"]}]
  :compute (fn [{:keys [bill tip-pct]}]
             (let [tip (* bill (/ tip-pct 100))]
               {:tip tip :total (+ bill tip)}))
  :logic (fn [{:keys [bill tip-pct]} out]
           [{:step "Tip" :formula "bill * tip% / 100" :value (:tip out)}])})`;

const server = spawn('npx', ['--yes', 'http-server', '.', '-p', String(port), '-c-1', '--silent'], {
  cwd: root,
  stdio: 'inherit',
});

let browser;
try {
  await waitForServer(`http://localhost:${port}/src/host/index.html`, 15000);
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  );
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(`http://localhost:${port}/src/host/index.html`);
  await page.waitForFunction(
    () => document.querySelector('.calculator-card h1')?.textContent === 'Tip calculator',
    { timeout: 15000 },
  );

  // "Show logic" renders the sandboxed :logic fn's real steps for the
  // current inputs/outputs.
  await page.click('.reveal-controls >> text=Show logic');
  await page.waitForSelector('.logic-panel', { timeout: 5000 });
  const logicText = await page.textContent('.logic-panel');
  assertIncludes(logicText, 'bill * tip% / 100', 'logic panel shows the real formula');
  assertIncludes(logicText, '9', 'logic panel shows the live computed tip value');

  // "Show source" reveals a textarea with the exact source that's running.
  await page.click('.reveal-controls >> text=Show source');
  await page.waitForSelector('.source-editor', { timeout: 5000 });
  const originalSource = await page.inputValue('.source-editor');
  assertIncludes(originalSource, 'Tip calculator', 'source editor shows the running source');

  // A bad edit (compute returns a non-numeric value for a :currency output)
  // fails the smoke test; the card keeps running the last-good calculator.
  await page.fill('.source-editor', BROKEN_SOURCE);
  await page.dispatchEvent('.source-editor', 'input');
  await page.click('.source-actions >> text=Apply');
  await page.waitForSelector('.source-error', { timeout: 5000 });
  const errorText = await page.textContent('.source-error');
  assertIncludes(errorText, 'finite number', 'inline error explains the smoke-test failure');
  assertEqual(
    await page.textContent('.calculator-card h1'),
    'Tip calculator',
    'title unchanged -- last-good calculator is still the one running',
  );
  assertIncludes(await page.textContent('.outputs'), '$9.00', 'outputs unchanged after a failed apply');

  // Revert discards the bad edit and clears the error.
  await page.click('.source-actions >> text=Revert');
  await page.waitForFunction(
    () => !document.querySelector('.source-error'),
    { timeout: 5000 },
  );
  const revertedSource = await page.inputValue('.source-editor');
  assertEqual(revertedSource, originalSource, 'revert restores the running source into the editor');

  // A good edit actually replaces the running calculator.
  await page.fill('.source-editor', GOOD_SOURCE_V2);
  await page.dispatchEvent('.source-editor', 'input');
  await page.click('.source-actions >> text=Apply');
  await page.waitForFunction(
    () => document.querySelector('.calculator-card h1')?.textContent === 'Tip calculator v2',
    { timeout: 5000 },
  );
  assertIncludes(await page.textContent('.outputs'), '$4.00', 'v2 defaults (bill=40, 10%) recompute to $4.00 tip');
  assertEqual(await page.$('.source-error'), null, 'no error after a successful apply');

  assertEqual(pageErrors.length, 0, 'no uncaught page errors');
  console.log('PASS: logic panel, and source apply/revert (bad edit then good edit), all work through the sandbox');
} finally {
  if (browser) await browser.close();
  server.kill();
}
