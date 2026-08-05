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
