/**
 * The telemetry kill switch (ADR-299).
 *
 * Required for CI, Docker, RunPod and anyone scripting the daemon: environments
 * where nobody is present to answer a consent prompt and where a stored consent
 * level may have been inherited from a baked image.
 *
 * `--no-telemetry` sets this env var at startup, so the flag and the env var
 * are the same mechanism rather than two code paths that can disagree.
 *
 * **This switch is one-way.** It can only ever turn telemetry OFF. No value of
 * it turns telemetry on, because consent is the only thing permitted to do
 * that — an environment variable must never be able to opt a user in.
 */

export const TELEMETRY_ENV = 'TURBOLLM_TELEMETRY'

/** The spellings of "no" we accept. Anything else (including "on") is ignored. */
const OFF_VALUES = new Set(['off', '0', 'false', 'no'])

/** Whether telemetry is hard-disabled regardless of stored consent. */
export function telemetryDisabled(): boolean {
  const raw = process.env[TELEMETRY_ENV]
  if (raw === undefined) return false
  return OFF_VALUES.has(raw.trim().toLowerCase())
}
