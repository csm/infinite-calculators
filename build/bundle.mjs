#!/usr/bin/env node
// Concatenates the vendored replicant sources and the app's .cljrs sources, in
// dependency order, into a single text bundle for the shell to `eval` into the
// main Repl at boot. See doc/plan.md §3 and vendor/replicant/NOTES.md for why
// this is a flat concatenation rather than per-file :require resolution.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const REPLICANT_ORDER = [
  'protocols', 'hiccup', 'hiccup_headers', 'vdom', 'console_logger',
  'assert', 'asserts', 'errors', 'transition', 'core', 'alias', 'dom',
].map((f) => join(root, 'vendor/replicant', `${f}.cljc`));

const APP_ORDER = [
  'json', 'contract', 'render', 'genpipe', 'core',
].map((f) => join(root, 'src/app', `${f}.cljrs`));

// The sandbox bundle (evaluated into each per-calculator worker's own Repl,
// see doc/plan.md §5) shares app.json/app.contract with the main bundle but
// never loads core.async/cljrs.dom/replicant -- those namespaces simply
// don't exist in a sandbox Repl, so a fully-qualified reference to one of
// them fails with "no such namespace" regardless of ns refers. `sandbox.env`
// is last so it's the active namespace -- and `calculator` resolves
// unqualified, as the §4 contract requires -- when calculator source text
// is eval'd.
const SANDBOX_ORDER = [
  join(root, 'src/app/json.cljrs'),
  join(root, 'src/app/contract.cljrs'),
  join(root, 'src/sandbox/protocol.cljrs'),
  join(root, 'src/sandbox/env.cljrs'),
];

function writeBundle(paths, outPath) {
  const parts = paths.map((path) => {
    const src = readFileSync(path, 'utf8');
    return `;; ---- ${path.slice(root.length + 1)} ----\n${src}`;
  });
  writeFileSync(outPath, parts.join('\n'));
  console.log(`wrote ${outPath} (${parts.length} files, ${parts.join('\n').length} bytes)`);
}

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
writeBundle([...REPLICANT_ORDER, ...APP_ORDER], join(outDir, 'bundle.cljrs'));
writeBundle(SANDBOX_ORDER, join(outDir, 'sandbox-bundle.cljrs'));
