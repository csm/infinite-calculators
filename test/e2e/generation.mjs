#!/usr/bin/env node
// Milestone-3 generation test (doc/plan.md §6/§12): the describe -> stream ->
// extract -> symbol-scan -> sandbox install pipeline, driven through the
// real app, real sandbox worker, and real proxy/server.mjs -- only the
// *model* is fake (proxy/providers/fake.mjs, via GENERATION_PROVIDER=fake),
// since there's no API key or network access to a real LLM in this test
// environment. Everything else (streaming SSE parsing, symbol scan, sandbox
// eval/validate/smoke-test, the repair-prompt round trip) is exercised for
// real. A failure stops and shows the bad source instead of auto-retrying
// (a real-world finding from this milestone -- see doc/plan.md); Retry
// re-queues a repair-style attempt on demand. Requires `npm run build` to
// have been run first.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const httpPort = 8126;
const proxyPort = 8790;

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

const httpServer = spawn('npx', ['--yes', 'http-server', '.', '-p', String(httpPort), '-c-1', '--silent'], {
  cwd: root,
  stdio: 'inherit',
});
const proxyServer = spawn('node', ['proxy/server.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, GENERATION_PROVIDER: 'fake', PORT: String(proxyPort) },
});

let browser;
try {
  await Promise.all([
    waitForServer(`http://localhost:${httpPort}/src/host/index.html`, 15000),
    waitForServer(`http://localhost:${proxyPort}/`, 15000).catch(() => {}), // 404s on GET /, just needs to be listening
  ]);

  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  );
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.addInitScript(
    (endpoint) => {
      window.GENERATE_ENDPOINT = endpoint;
    },
    `http://localhost:${proxyPort}/api/generate`,
  );

  await page.goto(`http://localhost:${httpPort}/src/host/index.html`);
  await page.waitForFunction(
    () => document.querySelector('.calculator-card h1')?.textContent === 'Tip calculator',
    { timeout: 15000 },
  );

  // Straightforward success: the fake provider returns a valid calculator
  // on the first attempt, so it should install with no repair round trip.
  await page.fill('.generation-panel input', 'a calculator that splits a bill with a tip');
  await page.dispatchEvent('.generation-panel input', 'input');
  await page.click('.generation-panel button');
  await page.waitForFunction(
    () => document.querySelector('.calculator-card h1')?.textContent === 'Fake tip calculator',
    { timeout: 15000 },
  );
  assertIncludes(await page.textContent('.outputs'), '$9.00', 'generated calculator computes tip on its own defaults');
  assertEqual(await page.inputValue('.generation-panel input'), '', 'description box clears after a successful generation');
  assertEqual(await page.$('.generation-error'), null, 'no error banner after a successful generation');

  // Failure + manual retry: MAKE_IT_BROKEN makes the fake provider's first
  // attempt an invalid calculator (fails the smoke test). It must stop
  // there -- no auto-retry -- and show the actual bad source alongside the
  // error, so a real failure can be inspected. Clicking Retry re-queues a
  // repair-style attempt (fake provider's repair turn returns a valid
  // calculator), which should then install successfully.
  await page.fill('.generation-panel input', 'MAKE_IT_BROKEN a tip calculator');
  await page.dispatchEvent('.generation-panel input', 'input');
  await page.click('.generation-panel button');
  await page.waitForSelector('.generation-error', { timeout: 20000 });
  assertIncludes(
    await page.textContent('.generation-bad-source-code'),
    'not a number',
    'the actual failing source is shown, not just a generic error',
  );
  assertEqual(
    await page.textContent('.calculator-card h1'),
    'Fake tip calculator',
    'the last-good calculator from the previous generation keeps running while this one is broken',
  );

  await page.click('.generation-error-actions >> text=Retry');
  await page.waitForFunction(() => !document.querySelector('.generation-error'), { timeout: 5000 });
  await page.waitForFunction(
    () => {
      const outputs = document.querySelector('.outputs')?.textContent || '';
      return document.querySelector('.calculator-card h1')?.textContent === 'Fake tip calculator'
        && outputs.includes('$9.00');
    },
    { timeout: 20000 },
  );
  assertEqual(await page.$('.generation-error'), null, 'no error banner once the manual retry succeeds');

  // Dismiss without retrying: ALWAYS_BROKEN_MARKER never recovers even on a
  // repair turn, so Dismiss (rather than Retry) should just clear the error
  // and bad-source panel, leaving the last-good calculator undisturbed.
  await page.fill('.generation-panel input', 'ALWAYS_BROKEN please');
  await page.dispatchEvent('.generation-panel input', 'input');
  await page.click('.generation-panel button');
  await page.waitForSelector('.generation-error', { timeout: 20000 });

  await page.click('.generation-error-actions >> text=Dismiss');
  await page.waitForFunction(
    () => !document.querySelector('.generation-error') && !document.querySelector('.generation-bad-source'),
    { timeout: 5000 },
  );
  assertEqual(
    await page.textContent('.calculator-card h1'),
    'Fake tip calculator',
    'the last-good calculator keeps running after dismissing a failed generation',
  );

  assertEqual(pageErrors.length, 0, 'no uncaught page errors');
  console.log('PASS: generation pipeline installs on first success, shows a failure with its bad source, recovers via manual retry, and dismiss clears a failure cleanly');
} finally {
  if (browser) await browser.close();
  httpServer.kill();
  proxyServer.kill();
}
