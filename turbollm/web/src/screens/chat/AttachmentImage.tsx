// A chat image. The daemon stores each sent image as a file and the message names it `attachment:<id>` (scalability
// review 2.7); messages from before that, and images it keeps inline, carry the data URL itself. A stored image is
// fetched with the auth header, which an <img src> cannot send (a LAN or remote-access browser needs a key), and
// shown from a blob URL. A voice clip is stored and fetched the same way (AttachmentAudio.tsx).
import { useEffect, useState } from 'react'
import { authHeaders } from '../../lib/api'

const REF_PREFIX = 'attachment:'
const IMAGE_CLASS = 'mt-2 max-h-48 max-w-xs rounded-lg object-contain'

/** A voice clip: a `data:audio/…` URL, or a stored file whose name says so (the daemon keeps clips as .wav or .mp3). */
export function isAudioAttachment(attachment: string): boolean {
  return attachment.startsWith('data:audio/') || (attachment.startsWith(REF_PREFIX) && /\.(wav|mp3)$/.test(attachment))
}

/** An image: every other stored attachment, and an inline image. A stored file used to be an image by definition;
 *  a clip shown as one is a broken picture. */
export function isImageAttachment(attachment: string): boolean {
  return attachment.startsWith('data:image') || (attachment.startsWith(REF_PREFIX) && !isAudioAttachment(attachment))
}

export type Loaded = { state: 'loading' } | { state: 'ready'; src: string } | { state: 'failed' }

/** The URL to show or play an attachment from: itself when it is inline, a blob URL of the stored file otherwise. */
export function useStoredAttachment(attachment: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  useEffect(() => {
    if (!attachment.startsWith(REF_PREFIX)) return
    // A different image: the previous one's blob URL was just revoked (cleanup below), so it is never shown again.
    setLoaded({ state: 'loading' })
    let objectUrl: string | null = null
    let cancelled = false
    const id = encodeURIComponent(attachment.slice(REF_PREFIX.length))
    fetch(`/api/v1/attachments/${id}`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`status ${res.status}`))))
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setLoaded({ state: 'ready', src: objectUrl })
      })
      .catch(() => { if (!cancelled) setLoaded({ state: 'failed' }) })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment])
  return attachment.startsWith(REF_PREFIX) ? loaded : { state: 'ready', src: attachment }
}

export function AttachmentImage({ attachment }: { attachment: string }) {
  const loaded = useStoredAttachment(attachment)
  if (loaded.state === 'failed') {
    return <div className={`${IMAGE_CLASS} border border-border px-3 py-2 text-[12px] text-muted`}>Image unavailable</div>
  }
  if (loaded.state === 'loading') return <div className={`${IMAGE_CLASS} h-24 w-32 bg-panel-2`} aria-hidden />
  return <img src={loaded.src} className={IMAGE_CLASS} alt="attached image" />
}
