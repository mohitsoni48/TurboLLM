/**
 * The consent-choice ping (ADR-299 Decision 5).
 *
 * This is the ONLY thing a machine that chose "Off" ever transmits, and it
 * exists solely to measure the opt-out rate. It is therefore the most sensitive
 * piece of code in the telemetry path, and is deliberately kept tiny:
 *
 * - It carries **nothing** but the chosen level — no machineId, no hardware, no
 *   OS, no timestamp. There is no field in it that could attribute it.
 * - It is sent **once ever** per install, never on subsequent changes.
 * - It is **never retried**. A failed send still spends the one-time claim,
 *   because retrying would mean a machine that opted out keeps talking to us.
 * - The `--no-telemetry` kill switch suppresses even this.
 *
 * The founder chose this over the alternative (log Off locally, transmit only
 * from machines that opted in, derive the opt-out rate from npm downloads).
 * That choice REQUIRES the consent copy to stop saying "Off sends nothing" —
 * see the UI copy and `architecture/08`. Shipping this ping while that copy
 * still claims otherwise is the one unacceptable outcome.
 *
 * Known limitation, accepted knowingly: with no machineId the ping is
 * undedupable and therefore trivially floodable, so the opt-out number it
 * yields is directional, not exact.
 */

import { claimOnce } from './ledger'
import { recordSent } from './log'
import { telemetryDisabled } from './disabled'
import { CONSENT_LEVELS, TELEMETRY_SCHEMA_VERSION } from './schema'
import { INGEST_URL, type Transport } from './uploader'

const httpTransport: Transport = async (events) => {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(events),
    signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}

/** Report the user's consent choice, exactly once, for any real level.
 *  `unset` is the absence of a choice and is never reported. */
export async function sendConsentChoice(
  dataDir: string,
  level: string,
  transport: Transport = httpTransport,
): Promise<void> {
  try {
    if (telemetryDisabled()) return
    if (!(CONSENT_LEVELS as readonly string[]).includes(level)) return
    if (!claimOnce(dataDir, 'consent_choice_sent')) return

    const ping = { schema: TELEMETRY_SCHEMA_VERSION, event: 'consent_choice', level }
    if (await transport([ping])) recordSent(dataDir, [ping])
  } catch {
    // Never retried, never surfaced.
  }
}
