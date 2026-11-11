// The strip above the chat box while the microphone is in use: what it is doing, and the choices that go with it.
// Shaped like the "Compacting conversation…" banner it sits beside, so the composer has one way of saying "busy".
import { useEffect, useState, useSyncExternalStore } from 'react'
import { AudioLines, Check, Loader2, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { formatClock } from '../../lib/voice/pcm'
import type { LevelMeter, VoiceInput } from './useVoiceInput'

const BANNER = 'flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 text-[13px] font-medium'
const BANNER_STYLE = { borderColor: 'var(--instruction-border)', background: 'var(--status-banner-bg)', color: 'var(--accent)' }

export function VoiceBar({ voice, autoStop }: { voice: VoiceInput; autoStop: boolean }) {
  const { phase } = voice
  if (phase === 'idle') return null

  if (phase === 'starting') {
    return (
      <div className={BANNER} style={BANNER_STYLE} role="status">
        <Loader2 size={14} className="shrink-0 animate-spin" />
        <span className="min-w-0 flex-1">Waiting for the microphone…</span>
        <DiscardButton label="Cancel" onClick={voice.cancel} />
      </div>
    )
  }

  if (phase === 'recording') {
    return (
      <div className={BANNER} style={BANNER_STYLE} role="status">
        <span className="tllm-pulse h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--err)' }} aria-hidden />
        <span>Listening <Clock since={voice.startedAt} /></span>
        <Level meter={voice.meter} />
        <span className="min-w-0 flex-1 text-[12px] font-normal text-muted">
          {autoStop ? 'Stops when you finish speaking.' : 'Press the microphone again when you are done.'}
        </span>
        <Button size="sm" onClick={() => void voice.stop()} title="Finish the recording">
          <Check size={14} /> Done
        </Button>
        <DiscardButton label="Discard the recording" onClick={voice.cancel} />
      </div>
    )
  }

  if (phase === 'choosing') return <Choice voice={voice} />

  return (
    <div className={BANNER} style={BANNER_STYLE} role="status">
      <Loader2 size={14} className="shrink-0 animate-spin" />
      <span className="min-w-0 flex-1">Converting speech to text…</span>
      <DiscardButton label="Cancel" onClick={voice.cancel} />
    </div>
  )
}

/** The question this feature exists to ask: the model can hear, so does the recording go to it as audio, or as the
 *  words in it? Asked once per recording until "Don't ask again" settles it (Settings → Voice changes it back). */
function Choice({ voice }: { voice: VoiceInput }) {
  const [remember, setRemember] = useState(false)
  return (
    <div className={BANNER} style={BANNER_STYLE} role="group" aria-label="How to send this recording">
      <AudioLines size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        Recorded {formatClock(voice.pendingMs)}
        <span className="ml-2 whitespace-nowrap text-[12px] font-normal text-muted">This model can hear audio.</span>
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => voice.choose('audio', remember)} title="The model hears your voice itself: tone, language and anything that is not words">
          Send as audio
        </Button>
        <Button size="sm" variant="outline" onClick={() => voice.choose('text', remember)} title="Whisper writes down what you said, so you can read and edit it before sending">
          Convert to text
        </Button>
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] font-normal text-muted">
          <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Don&rsquo;t ask again
        </label>
        <DiscardButton label="Discard the recording" onClick={voice.cancel} />
      </div>
    </div>
  )
}

function DiscardButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink">
      <X size={14} />
    </button>
  )
}

/** How long the recording has run, ticking by itself so the screen that owns the recorder does not re-render. */
function Clock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  return <span className="tabular-nums">{formatClock(now - since)}</span>
}

/** The input level as a bar: the proof that the microphone hears something before anything has been said back. */
function Level({ meter }: { meter: LevelMeter }) {
  const level = useSyncExternalStore(meter.subscribe, meter.level, () => 0)
  return (
    <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-border" aria-hidden>
      <span className="block h-full rounded-full transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%`, background: 'var(--accent)' }} />
    </span>
  )
}
