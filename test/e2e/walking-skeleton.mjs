#!/usr/bin/env node
// Milestone-1 walking skeleton smoke test (doc/plan.md §11/§12): boots the
// real app in a real browser (no mocks) and checks that changing an input
// recomputes and re-renders the outputs. Requires `npm run build` to have
// been run first (produces dist/bundle.cljrs and build/wasm-shell/pkg/).
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
  await page.waitForSelector('.calculator-card', { timeout: 15000 });

  assertEqual(pageErrors.length, 0, 'no uncaught page errors');

  const initialOutputs = await page.textContent('.outputs');
  assertEqual(initialOutputs.includes('Tip9.0$'), true, 'initial tip (bill=50, 18%) is 9.0');
  assertEqual(initialOutputs.includes('Total59.0$'), true, 'initial total is 59.0');

  const inputs = await page.$$('.field input');
  assertEqual(inputs.length, 2, 'two number inputs rendered');

  await inputs[0].fill('100');
  await inputs[0].dispatchEvent('input');
  await page.waitForFunction(
    () => document.querySelector('.outputs').textContent.includes('Tip18.0$'),
    { timeout: 5000 },
  );

  await inputs[1].fill('20');
  await inputs[1].dispatchEvent('input');
  await page.waitForFunction(
    () => document.querySelector('.outputs').textContent.includes('Tip20.0$'),
    { timeout: 5000 },
  );

  const finalOutputs = await page.textContent('.outputs');
  assertEqual(finalOutputs.includes('Total120.0$'), true, 'total after bill=100, tip=20% is 120.0');

  console.log('PASS: walking skeleton boots, renders, and recomputes on input');
} finally {
  if (browser) await browser.close();
  server.kill();
}
