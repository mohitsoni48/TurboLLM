// Whether a send asks for the model's reply as speech. A model that answers aloud (the status model's `audioOut`, which
// only this machine's own engine reports) is asked to when the message itself was spoken: the recording goes to it as
// audio, so the answer comes back the same way. There is no switch for it. A typed message, a recording converted to
// text, a linked machine's model and a model that only writes are all the ordinary text turn. So is a message the
// daemon would refuse an audio reply for (an image beside the recording, a clip that is not a WAV, more
// than about five minutes of recordings in all, `clipsMs`): it is sent as it
// always was, not refused with no way round it.
import type { LoadedModel } from './types'
import { MAX_RECORDING_MS } from './voice/recorder'

/** The most speech the daemon reads in one spoken turn, in all its clips: the recorder's own limit and the little it runs
 *  over before it stops (the daemon's MAX_SPOKEN_INPUT_MS). A message with more is sent as the ordinary turn. */
export const MAX_SPOKEN_TURN_MS = MAX_RECORDING_MS + 10_000

export function asksForSpokenReply(model: Pick<LoadedModel, 'audioOut'> | null | undefined, remote: boolean, clips: string[], images: string[] = [], clipsMs = 0): boolean {
  return !remote && model?.audioOut === true && clips.length > 0 && images.length === 0 && clipsMs <= MAX_SPOKEN_TURN_MS && clips.every((c) => c.startsWith('data:audio/wav'))
}
