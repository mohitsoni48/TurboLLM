// Whether a send asks for the model's reply as speech. A model that answers aloud (the status model's `audioOut`, which
// only this machine's own engine reports) is asked to when the message itself was spoken: the recording goes to it as
// audio, so the answer comes back the same way. There is no switch for it. A typed message, a recording converted to
// text, a linked machine's model and a model that only writes are all the ordinary text turn. So is a message the
// daemon would refuse an audio reply for (an image beside the recording, a clip that is not a WAV): it is sent as it
// always was, not refused with no way round it.
import type { LoadedModel } from './types'

export function asksForSpokenReply(model: Pick<LoadedModel, 'audioOut'> | null | undefined, remote: boolean, clips: string[], images: string[] = []): boolean {
  return !remote && model?.audioOut === true && clips.length > 0 && images.length === 0 && clips.every((c) => c.startsWith('data:audio/wav'))
}
