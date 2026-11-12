// The two chat registries a fake `Deps` needs (Deps.chatTurns, Deps.chatRuns), fresh per call: bootDaemon builds the
// real ones once per daemon, and a test that fakes Deps spreads this in so it never shares turns with another test.
import { ChatRuns } from '../chat/chat-runs'
import { ChatTurns } from '../chat/chat-turns'

export function chatRegistries(): { chatTurns: ChatTurns; chatRuns: ChatRuns } {
  return { chatTurns: new ChatTurns(), chatRuns: new ChatRuns() }
}
