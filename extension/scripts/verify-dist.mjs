#!/usr/bin/env node
// verify-dist.mjs — post-build bundle regression checks for extension contexts.
// Run after `npm run build` (or `npm run check:dist`).
//
// Guards three regressions that unit tests cannot catch (vitest transforms
// don't emit Vite's build-time preload machinery):
//   1. The popup entry statically importing the remark/micromark stack
//      (the startup-lag regression: ~134 KB parsed on every popup open).
//   2. Vite's preload-deps injection (`__vite__mapDeps`) in the service-worker
//      chunk: the preload helper touches `document`, which does NOT exist in
//      MV3 service workers, so `import('./zip-build-service')` threw
//      ReferenceError on every zip build. With `build.modulePreload: false`
//      the call site passes empty deps and the helper body is inert (the
//      `document` access sits behind `if (deps && deps.length > 0)`), but the
//      mapDeps vector must stay gone.
//   3. modulepreload links in the popup HTML (Chromium "cross-world extension
//      resource mismatch" / "preloaded but not used" console warnings).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const manifestPath = join(distDir, '.vite', 'manifest.json');
const errors = [];

if (!existsSync(manifestPath)) {
  console.error('dist/.vite/manifest.json not found — run `npm run build` first.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = Object.values(manifest);

// 1. Popup entry + its transitive static imports must not contain the remark stack.
const popupEntry = entries.find((e) => e.isEntry && e.src?.includes('index.html'));
if (!popupEntry) {
  errors.push('popup entry chunk not found in manifest');
} else {
  const seen = new Set();
  const files = [popupEntry.file];
  for (const file of [...files]) {
    if (seen.has(file)) continue;
    seen.add(file);
    const chunk = Object.values(manifest).find((c) => c.file === file);
    for (const imp of chunk?.imports ?? []) files.push(manifest[imp].file);
  }
  for (const file of seen) {
    if (readFileSync(join(distDir, file), 'utf8').includes('micromark')) {
      errors.push(`popup import graph contains remark stack: ${file}`);
    }
  }
}

// 2. Service-worker chunk must not contain the preload-deps injection.
const swEntry = entries.find((e) => e.isEntry && e.src?.includes('background'));
if (!swEntry) {
  errors.push('background chunk not found in manifest');
} else {
  const src = readFileSync(join(distDir, swEntry.file), 'utf8');
  if (src.includes('__vite__mapDeps')) {
    errors.push('background chunk contains __vite__mapDeps (SW document crash vector)');
  }
}

// 3. The zip-build chunk must exist as a lazily-loaded chunk (dynamic import).
const lazyZip = entries.find((e) => e.src?.includes("zip-build-service"));
if (!lazyZip) errors.push('lazy zip-build-service chunk missing');

// 4. The popup HTML must not emit modulepreload links.
const indexHtml = join(distDir, 'index.html');
if (existsSync(indexHtml) && readFileSync(indexHtml, 'utf8').includes('modulepreload')) {
  errors.push('index.html contains modulepreload links');
}

if (errors.length > 0) {
  console.error('DIST VERIFY FAILED:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log(
  `DIST VERIFY OK (popup entry: ${popupEntry?.file}, sw: ${swEntry?.file}, lazy zip: ${lazyZip?.file})`,
);
