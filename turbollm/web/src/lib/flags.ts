/**
 * Build-time feature flags for the web UI.
 *
 * These are plain constants (not env-driven) so they tree-shake out of the
 * production bundle when disabled — a flag set to `false` removes the gated UI
 * and its imports from the shipped assets entirely.
 */

/**
 * Telemetry / analytics UI (Settings → Privacy & telemetry; ADR-299).
 *
 * ON since 2026-07-30. It was `false` from the MVP launch through v1.9 because
 * ADR-041's condition was never met: there was no uploader and no backend, so
 * the consent control would have led nowhere, and asking for consent you cannot
 * honour is worse than not asking.
 *
 * That condition is now satisfied and verified, not assumed — the ingest Worker
 * is deployed at `t.turbollm.dev`, and an event sent by the real client modules
 * over the real transport was confirmed present in D1, with a deliberately
 * poisoned event rejected at both the client and the edge.
 *
 * Turning this on reveals the Settings "Privacy & telemetry" section. There is no
 * first-run consent card (removed 2026-08-01, superseding ADR-299 Decision 4):
 * telemetry now defaults ON (`full`) for every install, and a user who wants to
 * opt out or narrow the level changes it there, any time.
 */
export const TELEMETRY_UI_ENABLED = true
