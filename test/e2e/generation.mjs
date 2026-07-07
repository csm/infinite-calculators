#!/usr/bin/env node
// Milestone-3 generation test (doc/plan.md §6/§12): the describe -> stream ->
// extract -> symbol-scan -> sandbox install -> (repair)* pipeline, driven
// through the real app, real sandbox worker, and real proxy/server.mjs --
// only the *model* is fake (proxy/providers/fake.mjs, via
// GENERATION_PROVIDER=fake), since there's no API key or network access to
// a real LLM in this test environment. Everything else (streaming SSE
// parsing, symbol scan, sandbox eval/validate/smoke-test, the repair-prompt
// round trip) is exercised for real. Requires `npm run build` to have been
// run first.
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

  // Repair loop: MAKE_IT_BROKEN makes the fake provider's first attempt an
  // invalid calculator (fails the smoke test); its second attempt (the
  // repair turn) returns a valid one. The pipeline should recover on its
  // own and still end up installed, proving the failed first attempt didn't
  // just surface as a dead end.
  await page.fill('.generation-panel input', 'MAKE_IT_BROKEN a tip calculator');
  await page.dispatchEvent('.generation-panel input', 'input');
  await page.click('.generation-panel button');
  await page.waitForFunction(
    () => {
      const outputs = document.querySelector('.outputs')?.textContent || '';
      return document.querySelector('.calculator-card h1')?.textContent === 'Fake tip calculator'
        && outputs.includes('$9.00');
    },
    { timeout: 20000 },
  );
  assertEqual(await page.$('.generation-error'), null, 'no error banner once the repair attempt succeeds');

  // Give up: ALWAYS_BROKEN_MARKER makes every attempt (including repair
  // turns) invalid, so the pipeline should exhaust its retries and surface
  // a friendly error -- without disturbing the calculator that's already
  // running.
  await page.fill('.generation-panel input', 'ALWAYS_BROKEN please');
  await page.dispatchEvent('.generation-panel input', 'input');
  await page.click('.generation-panel button');
  await page.waitForSelector('.generation-error', { timeout: 20000 });
  const errorText = await page.textContent('.generation-error');
  assertIncludes(errorText, 'Generation failed after 3 attempts', 'gives up after exhausting repair attempts');
  assertEqual(
    await page.textContent('.calculator-card h1'),
    'Fake tip calculator',
    'the last-good calculator keeps running after a generation gives up',
  );

  await page.click('.generation-error >> text=Dismiss');
  await page.waitForFunction(() => !document.querySelector('.generation-error'), { timeout: 5000 });

  assertEqual(pageErrors.length, 0, 'no uncaught page errors');
  console.log('PASS: generation pipeline installs on first success, recovers via repair, and gives up cleanly after exhausting retries');
} finally {
  if (browser) await browser.close();
  httpServer.kill();
  proxyServer.kill();
}
