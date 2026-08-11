import { defineConfig, devices } from '@playwright/test'

// Onboarding E2E harness (spec 25 §10.3) — runs INSIDE docker-compose.test.yaml's
// container, against the real built daemon the entrypoint already started on its
// own port. Unlike playwright.config.ts (which spins up a vite dev server on
// 5173 for the Code-UI specs), this config has NO webServer block: the daemon
// is already running by the time this is invoked (via `docker exec`), and
// nothing here ever binds a port on the HOST — Playwright's own traffic to
// 127.0.0.1:6996 stays entirely inside the container's network namespace.
export default defineConfig({
  testDir: './e2e-onboarding',
  fullyParallel: false, // shared tmpfs ~/.turbollm — tests must not race each other
  // `fullyParallel: false` alone only serializes tests WITHIN one file — Playwright still
  // defaults to multiple WORKERS across separate spec files, which is exactly a second race
  // on the same shared daemon/tmpfs. Invisible while wizard.spec.ts was the only file; adding
  // deep-flow.spec.ts immediately produced cross-file interference (DOM-detached timeouts,
  // navigation assertions racing another file's page.goto). One worker for the whole run.
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:6996',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
