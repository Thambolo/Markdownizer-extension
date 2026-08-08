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

// 5. SW smoke test: evaluate the REAL built background chunk in a
//    worker-like environment (node has no document/window, exactly like an
//    MV3 service worker) and dispatch build_zip end-to-end. Guards the
//    module-evaluation failures of the remark stack (browser-condition
//    entity decoder creating a DOM element at module scope) and Vite's
//    preload machinery. Also proves the aliased entity decoder actually
//    decodes (page.md must contain 'Intro & more', not 'Intro  more').
if (!errors.length) {
  await swSmokeTest();
}

async function swSmokeTest() {
  const { pathToFileURL } = await import('node:url');
  const sessionData = {};
  const downloads = [];
  let messageListener = null;

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (listener) => { messageListener = listener; } },
      sendMessage: async () => {},
    },
    storage: {
      sync: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async (keys) => {
          const key = Array.isArray(keys) ? keys[0] : keys;
          return key in sessionData ? { [key]: sessionData[key] } : {};
        },
        set: async (items) => Object.assign(sessionData, items),
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) delete sessionData[key];
        },
      },
    },
    downloads: {
      download: async ({ url, filename }) => downloads.push({ url, filename }),
    },
    scripting: { executeScript: async () => [] },
  };
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));

  try {
    await import(pathToFileURL(join(distDir, swEntry.file)).href);
    const response = await new Promise((resolve) => {
      messageListener(
        {
          action: 'build_zip',
          buildId: 'smoke-1',
          payload: {
            markdown: 'Intro &amp; more\n\n![Hero](https://e.com/hero.png)',
            title: 'page',
            sourceUrl: 'https://e.com',
          },
        },
        {},
        resolve,
      );
    });

    if (!response?.success || downloads.length !== 1) {
      errors.push(`SW smoke: build_zip failed (response=${JSON.stringify(response)})`);
      return;
    }
    const { url, filename } = downloads[0];
    if (!filename.endsWith('.zip') || !url.startsWith('data:application/zip;base64,')) {
      errors.push(`SW smoke: unexpected download (${filename}, ${String(url).slice(0, 40)})`);
      return;
    }
    const bytes = new Uint8Array(Buffer.from(url.split(',')[1], 'base64'));
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(bytes);
    const readme = strFromU8(files['README.md']);
    const md = strFromU8(files['page.md']);
    if (!readme.includes('https://e.com')) errors.push('SW smoke: README missing source url');
    if (!md.includes('![Hero](images/img-001.png)')) errors.push('SW smoke: image reference not rewritten');
    // Surgical-rewrite invariant through the SW path: the original markdown
    // text is preserved verbatim (remark decodes entities only in the AST for
    // position lookup; the output slices the original string).
    if (!md.includes('Intro &amp; more')) errors.push('SW smoke: non-image text not preserved verbatim');
    if (sessionData.activeZipBuild !== undefined) errors.push('SW smoke: activeZipBuild not cleared after done');
  } catch (err) {
    errors.push(`SW smoke: chunk evaluation or dispatch failed: ${err.message}`);
  }
}

if (errors.length > 0) {
  console.error('DIST VERIFY FAILED:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log(
  `DIST VERIFY OK (popup entry: ${popupEntry?.file}, sw: ${swEntry?.file}, lazy zip: ${lazyZip?.file})`,
);
