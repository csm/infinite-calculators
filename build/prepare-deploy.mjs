#!/usr/bin/env node
// Stages exactly the runtime-required files into deploy/ for the SFTP
// deploy workflow (.github/workflows/deploy.yml). The app fetches/imports
// everything by a root-relative path (see src/host/main.js,
// sandbox-manager.js, sandbox-worker.js), so deploy/ mirrors those paths
// as-is rather than flattening anything -- only three directories are ever
// referenced at runtime: /dist, /build/wasm-shell/pkg, and /src/host.
// Requires `npm run build` to have been run first (produces dist/ and
// build/wasm-shell/pkg/).
import { cpSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployDir = join(root, 'deploy');

for (const required of ['dist', 'build/wasm-shell/pkg']) {
  if (!existsSync(join(root, required))) {
    console.error(`missing ${required} -- run \`npm run build\` first`);
    process.exit(1);
  }
}

rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

cpSync(join(root, 'dist'), join(deployDir, 'dist'), { recursive: true });
cpSync(join(root, 'build/wasm-shell/pkg'), join(deployDir, 'build/wasm-shell/pkg'), { recursive: true });
cpSync(join(root, 'src/host'), join(deployDir, 'src/host'), { recursive: true });
cpSync(join(root, 'build/deploy.htaccess'), join(deployDir, '.htaccess'));

// The app's real entry point is /src/host/index.html (its script/style tags
// are relative to that path); this is just a plain redirect so visiting the
// deployed domain's root works without duplicating or rewriting any app
// paths.
writeFileSync(
  join(deployDir, 'index.html'),
  '<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=/src/host/index.html">\n<a href="/src/host/index.html">Infinite Calculators</a>\n',
);

console.log(`staged deploy/ (dist/, build/wasm-shell/pkg/, src/host/, redirect index.html, .htaccess)`);
