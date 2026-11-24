import type { ConversationMode } from './useConversationMode'

export interface ConversationSendResult {
  started: boolean
  aborted: boolean
}

// Hand the message over now, but use this call's result when it settles. Barge-in can
// start a new recording before the old send resolves; aborting that send is not a
// refusal of the new turn and must not send it back to idle with the mic open.
export async function sendForConversation(
  conversation: Pick<ConversationMode, 'emit'>,
  send: () => Promise<ConversationSendResult>,
): Promise<void> {
  conversation.emit({ type: 'message-sent' })
  const { started, aborted } = await send()
  if (!started && !aborted) conversation.emit({ type: 'send-failed' })
}
