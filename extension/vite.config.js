import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [
    preact(),
    crx({ manifest }),
  ],
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
