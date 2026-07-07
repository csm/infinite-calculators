#!/usr/bin/env node
// Milestone-1/2 walking-skeleton smoke test (doc/plan.md §11/§12): boots the
// real app in a real browser (no mocks) and checks that the golden
// calculator installs through the real sandbox pipeline (worker, contract
// validation, smoke test) and that changing an input recomputes through the
// sandbox worker and re-renders. Requires `npm run build` to have been run
// first (produces dist/bundle.cljrs, dist/sandbox-bundle.cljrs, and
// build/wasm-shell/pkg/).
//
// Usage: node test/e2e/walking-skeleton.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = 8123;

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
  // The golden calculator installs through a real worker + sandbox Repl
  // (doc/plan.md §5), so the first render is the "Installing..." banner;
  // wait for the sandbox round trip to finish and the real title to land.
  await page.waitForFunction(
    () => document.querySelector('.calculator-card h1')?.textContent === 'Tip calculator',
    { timeout: 15000 },
  );

  assertEqual(pageErrors.length, 0, 'no uncaught page errors');

  const initialOutputs = await page.textContent('.outputs');
  assertIncludes(initialOutputs, '$9.00', 'initial tip (bill=50, 18%) is $9.00');
  assertIncludes(initialOutputs, '$59.00', 'initial total is $59.00');

  const inputs = await page.$$('.field input');
  assertEqual(inputs.length, 2, 'two number inputs rendered');

  await inputs[0].fill('100');
  await inputs[0].dispatchEvent('input');
  await page.waitForFunction(
    () => document.querySelector('.outputs').textContent.includes('$18.00'),
    { timeout: 5000 },
  );

  await inputs[1].fill('20');
  await inputs[1].dispatchEvent('input');
  await page.waitForFunction(
    () => document.querySelector('.outputs').textContent.includes('$20.00'),
    { timeout: 5000 },
  );

  const finalOutputs = await page.textContent('.outputs');
  assertIncludes(finalOutputs, '$120.00', 'total after bill=100, tip=20% is $120.00');

  console.log('PASS: walking skeleton boots through the sandbox pipeline and recomputes on input');
} finally {
  if (browser) await browser.close();
  server.kill();
}
