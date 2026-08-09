import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The daemon embeds the built assets (../internal/webui/dist) so it ships as one
// binary. In dev, `npm run dev` proxies API calls to the running daemon on :8080.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // ws: true — without it, Vite's dev-server proxy only forwards plain HTTP requests
      // under /api; a WebSocket upgrade (the embedded terminal's /api/v1/code/terminal/ws,
      // terminal-routes.ts) never reaches the daemon at all when viewing the app through
      // `npm run dev` (port 5173) instead of the built daemon UI on :6996 — the browser sees
      // the connection close with no status (code 1005), even though the daemon's own WS
      // handling is completely healthy.
      '/api': { target: 'http://127.0.0.1:6996', ws: true },
      '/healthz': 'http://127.0.0.1:6996',
      '/v1': 'http://127.0.0.1:6996',
    },
  },
  test: {
    environment: 'jsdom',
    // jsdom's default document origin is the opaque `about:blank` — its own localStorage
    // implementation throws "not accessible" under an opaque origin, which crashes any
    // component test that (transitively) imports stores/ui.ts at module init (reads
    // localStorage for the persisted theme/font-size). A real http(s) URL gives it a real
    // origin, so localStorage behaves like an actual browser instead of needing a hand-rolled
    // polyfill (setup.ts still stubs matchMedia separately — jsdom never implements that one).
    environmentOptions: { jsdom: { url: 'http://localhost:3000' } },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Node 22+ ships its own global `localStorage` (the `--webstorage` flag, on by default),
    // which shadows jsdom's implementation entirely and throws without a `--localstorage-file`
    // path configured — the root cause setup.ts's polyfill works around at the JS layer. That
    // polyfill wins functionally (it overwrites the global before any test file's imports run),
    // but Node still prints its own startup warning about the unset flag regardless, since the
    // warning fires independently of whether the global later gets overwritten. Disabling the
    // feature outright on the actual worker processes Vitest spawns removes the warning at the
    // source instead of just working around its symptom.
    execArgv: ['--no-experimental-webstorage'],
    // engine-groups/personas/tool-explain/vram already use `node:test` and run via the
    // repo root's `tsx --test` (backend convention) — leave them to that runner rather
    // than having Vitest try (and fail) to collect them too.
    exclude: [
      '**/node_modules/**',
      '**/e2e/**',
      // Docker-only Playwright suite (spec 25 §10.3) — a sibling of e2e/, not
      // nested under it, so the OTHER playwright config (testDir: './e2e',
      // which spins up a vite dev server on 5173) never also collects it: this
      // suite assumes the real daemon on 6996, not a dev-server proxy.
      '**/e2e-onboarding/**',
      'src/lib/engine-groups.test.ts',
      'src/lib/personas.test.ts',
      'src/lib/tool-explain.test.ts',
      'src/lib/vram.test.ts',
    ],
  },
  build: {
    outDir: '../src/webdist',
    // Wipe the output dir on each build. webdist is purely generated (served by
    // the daemon and copied into dist/ at package build) — without this, vite
    // leaves stale hashed chunks behind every build, bloating the npm package.
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React runtime — cached separately from app logic.
          vendor: ['react', 'react-dom', 'react-router-dom'],
          // Radix UI primitives — large but stable; cache-friendly.
          radix: [
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-separator',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
          ],
        },
      },
    },
  },
})
