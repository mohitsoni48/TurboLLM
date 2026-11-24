import type { ConversationMode } from './useConversationMode'

export interface ConversationSendResult {
  started: boolean
  aborted: boolean
}

// Each emitter belongs to one mounted conversation controller. Only its latest
// send can refuse the current turn; an older result may settle after barge-in.
const latestSend = new WeakMap<ConversationMode['emit'], number>()

// Hand the message over now, but use this call's result when it settles. Barge-in can
// start a new recording before the old send resolves; aborting that send is not a
// refusal of the new turn and must not send it back to idle with the mic open.
export async function sendForConversation(
  conversation: Pick<ConversationMode, 'emit'>,
  send: () => Promise<ConversationSendResult>,
): Promise<void> {
  const turn = (latestSend.get(conversation.emit) ?? 0) + 1
  latestSend.set(conversation.emit, turn)
  conversation.emit({ type: 'message-sent' })
  const { started, aborted } = await send()
  if (latestSend.get(conversation.emit) === turn && !started && !aborted) conversation.emit({ type: 'send-failed' })
}
