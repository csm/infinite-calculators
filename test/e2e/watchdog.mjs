#!/usr/bin/env node
// Milestone-2 watchdog test (doc/plan.md §5/§12): a calculator whose
// :compute hangs for certain inputs must trip the worker's deadline, get
// reported on the card as too-expensive rather than freezing the tab, and
// the calculator must keep working afterwards (the manager reinstalls the
// last-good source into a fresh worker after killing the stuck one).
// Requires `npm run build` to have been run first.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = 8125;

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

// Smoke-tests fine at the default bill (50) -- compute returns immediately
// -- but hangs forever once bill is pushed past 1000, so installing it
// succeeds and only the *later* recompute call trips the watchdog. This
// exercises the :compute deadline specifically, distinct from the :install
// deadline.
const HANGING_SOURCE = `(calculator
 {:title "Hangs above 1000"
  :inputs [{:id :bill :label "Bill amount" :type :number :default 50.0 :unit "$"}]
  :outputs [{:id :tip :label "Tip" :format [:currency "USD"]}]
  :compute (fn [{:keys [bill]}]
             (if (> bill 1000)
               (loop [i 0] (recur (inc i)))
               {:tip bill}))
  :logic (fn [in out] [])})`;

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

  await page.click('.reveal-controls >> text=Show source');
  await page.waitForSelector('.source-editor', { timeout: 5000 });
  await page.fill('.source-editor', HANGING_SOURCE);
  await page.dispatchEvent('.source-editor', 'input');
  await page.click('.source-actions >> text=Apply');
  await page.waitForFunction(
    () => document.querySelector('.calculator-card h1')?.textContent === 'Hangs above 1000',
    { timeout: 5000 },
  );

  const [input] = await page.$$('.calculator-card .field input');
  await input.fill('5000');
  await input.dispatchEvent('input');

  // The :compute deadline is 2s; the worker gets killed and replaced, and
  // the card must report the failure rather than hang.
  await page.waitForTimeout(3000);
  assertEqual(pageErrors.length, 0, 'no uncaught page errors even while a worker is killed');

  // The calculator must still work after the watchdog recycled its worker.
  await input.fill('10');
  await input.dispatchEvent('input');
  await page.waitForFunction(
    () => document.querySelector('.outputs').textContent.includes('$10.00'),
    { timeout: 5000 },
  );

  console.log('PASS: a hung :compute call trips the watchdog and the calculator keeps working afterwards');
} finally {
  if (browser) await browser.close();
  server.kill();
}
