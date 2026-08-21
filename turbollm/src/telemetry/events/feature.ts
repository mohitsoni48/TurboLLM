/** Feature-discovery events (spec 24, ADR-333). Unchanged from ADR-299
 *  Decision 6 / the telemetry-review follow-through that wired up
 *  `feature_used_daily`'s emission. */

import { defineEvent, f } from '../core/define'
import { COUNT_BUCKETS, FEATURES } from '../core/enums'

export const featureFirstUse = defineEvent({
  name: 'feature_first_use',
  since: 1,
  consent: 'anon',
  lifecycle: 'once-by-key',
  description: 'A product surface (chat, code, research, ...) was touched for the first time ever on this install.',
  payload: {
    feature: f.enum(FEATURES),
  },
})

export const featureUsedDaily = defineEvent({
  name: 'feature_used_daily',
  since: 1,
  consent: 'anon',
  lifecycle: 'daily-rollup',
  description: "Yesterday's bucketed usage count for one feature, emitted the moment the calendar day rolls over.",
  payload: {
    feature: f.enum(FEATURES),
    countBucket: f.enum(COUNT_BUCKETS),
    /** Whole days back from this event's `ts` that this count describes —
     *  see `chat.ts` for the full rationale. */
    daysAgo: f.int({ min: 0, max: 366, optional: true }),
  },
})
