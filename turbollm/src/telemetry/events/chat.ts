/** Chat volume (spec 23 §3.4, ADR-333). Read-only aggregation over the
 *  existing `conversations`/`messages` tables (`ConversationStore.
 *  chatDailyStats`) — no new write on the chat send path. */

import { defineEvent, f } from '../core/define'

export const chatDaily = defineEvent({
  name: 'chat_daily',
  since: 2,
  consent: 'full',
  lifecycle: 'daily-rollup',
  description: "Yesterday's chat volume for this machine — conversations touched, total messages, and per-conversation shape.",
  payload: {
    // Which day these counters actually describe, as a whole-day offset back from
    // this event's own `ts` (2026-08-21 data-integrity audit). Normally 1. Larger
    // whenever the daemon was closed across one or more midnights, because
    // `takeRolledOver()` reports the last day it TRACKED, not yesterday.
    //
    // Without this the day was unrecoverable: the event is stamped at emit time,
    // so every chart built on `timestamp` silently attributed a rollup to the
    // wrong date, and 17.7% of rows described a day 2+ back. Sent as an int
    // rather than a date string on purpose — the load-bearing schema rule is that
    // no field is free-form text (schema.ts), and an offset is both bounded and
    // strictly less identifying than a date while carrying the same information:
    // the real day is `toDate(ts) - daysAgo`.
    //
    // OPTIONAL, and it must stay that way. Every client already in the field emits
    // this event without the field, so a REQUIRED `daysAgo` would make the newly
    // deployed Worker reject all of them — the identical compatibility break that
    // silently killed `onboarding_step` for every already-shipped binary. Absent
    // means "an older client that could not tell us"; treat those rows as
    // day-unknown rather than assuming 1.
    daysAgo: f.int({ min: 0, max: 366, optional: true }),
    conversations: f.int(),
    messages: f.int(),
    maxMessagesInConversation: f.int(),
    medianMessagesInConversation: f.int(),
    distinctModels: f.int(),
    toolCalls: f.int(),
    regenerates: f.int(),
    stops: f.int(),
  },
})
