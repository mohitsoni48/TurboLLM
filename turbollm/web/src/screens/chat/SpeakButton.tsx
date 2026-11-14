// "Read aloud" on a reply: speaks it in the device's voice (lib/voice/tts.ts), and becomes "stop" while it does.
// Absent where nothing can speak, rather than a button that stays silent.
import { Square, Volume2 } from 'lucide-react'
import { useReadAloud, useTtsAvailable } from '../../lib/voice/use-tts'

export function SpeakButton({ id, text }: { id: string; text: string }) {
  const available = useTtsAvailable()
  const { speakingId, toggle } = useReadAloud()
  if (!available) return null
  const speaking = speakingId === id
  const label = speaking ? 'Stop reading' : 'Read aloud'
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={speaking}
      onClick={() => toggle(id, text)}
      className="rounded p-1 transition-colors hover:bg-panel-2"
      style={{ color: speaking ? 'var(--accent)' : 'var(--faint)' }}
    >
      {speaking ? <Square size={12} /> : <Volume2 size={12} />}
    </button>
  )
}
