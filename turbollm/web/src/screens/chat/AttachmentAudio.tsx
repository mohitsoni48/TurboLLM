// A voice message as it was sent: a player for the clip. Shown on a user message whose recording went to the model
// as audio; a recording that was converted to text has no clip, only its words.
import { Mic } from 'lucide-react'
import { isAudioAttachment, useStoredAttachment } from './AttachmentImage'

export { isAudioAttachment }

const FRAME = 'mt-2 flex max-w-full items-center gap-2 rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[12px] text-muted'

export function AttachmentAudio({ attachment }: { attachment: string }) {
  const loaded = useStoredAttachment(attachment)
  if (loaded.state === 'failed') return <div className={FRAME}><Mic size={13} className="shrink-0" /> Voice message unavailable</div>
  if (loaded.state === 'loading') return <div className={`${FRAME} h-10 w-72`} aria-hidden />
  return (
    <div className={FRAME}>
      <Mic size={13} className="shrink-0" aria-hidden />
      {/* preload="metadata": the length shows without the browser decoding every clip in a long chat. */}
      <audio controls preload="metadata" src={loaded.src} className="h-8 w-72 max-w-full" aria-label="Voice message" />
    </div>
  )
}
