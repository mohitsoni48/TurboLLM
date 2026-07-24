import { defineConfig, devices } from '@playwright/test'

// Real-browser E2E for the Code UI redesign (ADR-253) — jsdom (Vitest) can't catch
// overflow/clipping layout bugs, which is part of why this suite exists.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    // 'localhost' (not '127.0.0.1') — on this machine Node/Vite binds the dev server's
    // loopback listener to IPv6 (::1) only, so an IPv4-literal health check/navigation
    // times out even though the server is up.
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Spins up its own `vite` dev server scoped to the test run on the standard web-dev
  // port (5173, per .claude/launch.json) rather than a one-off port. This is just the
  // Vite frontend server — it does not touch ~/.turbollm; API calls proxy to whatever
  // daemon (if any) is already running on :6996, and the smoke test only asserts on
  // static chrome that renders regardless of daemon/auth state.
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
