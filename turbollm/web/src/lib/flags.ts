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
 * Turning this on reveals two surfaces: the Settings "Privacy & telemetry"
 * section, and the first-run consent card (which forces an explicit choice with
 * no pre-selected default). Nothing transmits until a user picks a level above
 * Off — except the one-time record of that choice itself, which the Off copy
 * states plainly (ADR-299 Decision 5).
 */
export const TELEMETRY_UI_ENABLED = true
