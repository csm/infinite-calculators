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
  'render', 'core',
].map((f) => join(root, 'src/app', `${f}.cljrs`));

const parts = [...REPLICANT_ORDER, ...APP_ORDER].map((path) => {
  const src = readFileSync(path, 'utf8');
  return `;; ---- ${path.slice(root.length + 1)} ----\n${src}`;
});

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'bundle.cljrs');
writeFileSync(outPath, parts.join('\n'));
console.log(`wrote ${outPath} (${parts.length} files, ${parts.join('\n').length} bytes)`);
