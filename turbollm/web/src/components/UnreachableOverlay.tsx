import { Loader2 } from 'lucide-react'

/** Full-screen non-dismissible overlay shown after the status poll fails ×3
 *  (spec 08 §1). Auto-recovers on the next OK poll (the parent stops rendering it). */
export function UnreachableOverlay() {
  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4"
      style={{ background: 'color-mix(in srgb, var(--bg) 92%, transparent)' }}
      role="alertdialog"
      aria-label="Lost connection to daemon"
    >
      <Loader2 size={24} className="animate-spin text-muted" />
      <p className="text-[14px] text-ink">
        Lost connection to TurboLLM daemon — retrying…
      </p>
    </div>
  )
}
