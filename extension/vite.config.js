import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [
    preact(),
    crx({ manifest }),
  ],
  resolve: {
    alias: [
      {
        // decode-named-character-reference's `browser` export (index.dom.js)
        // creates `document.createElement("i")` at MODULE SCOPE to decode HTML
        // entities — unresolvable in the MV3 service worker, so any dynamic
        // import of the remark stack from the SW fails to evaluate
        // (ReferenceError: document is not defined). The `worker`/default
        // entry (index.js) is a pure data map, isomorphic across browser,
        // worker, and SW — use it for every build.
        find: 'decode-named-character-reference',
        replacement: new URL(
          './node_modules/decode-named-character-reference/index.js',
          import.meta.url,
        ).pathname,
      },
    ],
  },
  build: {
    // Vite's module-preload machinery (preload-polyfill + <link
    // rel="modulepreload">) is incompatible with extension contexts:
    // - The polyfill is injected into any chunk with a dynamic import that
    //   has dependencies and touches `document` — which does not exist in the
    //   MV3 service worker, so `import('./zip-build-service')` throws
    //   ReferenceError on every zip build.
    // - modulepreload links in extension pages produce Chromium
    //   "cross-world extension resource mismatch" / "preloaded but not used"
    //   console warnings.
    // Dynamic imports still work via plain `import()`; chunks load on demand.
    modulePreload: false,
  },
});
