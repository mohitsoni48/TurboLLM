import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { track } from '../../lib/api'

export function CopyButton({
  text,
  label,
  size = 13,
  className,
  screen,
}: {
  text: string
  label?: string
  size?: number
  className?: string
  screen: 'engines' | 'models' | 'developer' | 'settings' | 'code' | 'chat'
}) {
  const [copied, setCopied] = useState(false)

  const handle = () => {
    track(screen, 'copy_button_click')
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const padding = label != null ? 'px-2 py-1 text-[12px]' : 'p-1'

  return (
    <button
      type="button"
      onClick={handle}
      title={copied ? 'Copied!' : 'Copy'}
      // Real accessible name always, not just a title tooltip — matters most for the icon-only
      // case (no `label` passed), where the button otherwise has no accessible name at all.
      aria-label={copied ? 'Copied' : (label ?? 'Copy')}
      className={`inline-flex items-center gap-1.5 rounded transition-colors ${
        copied ? '' : 'text-faint hover:text-ink'
      } ${padding} ${className ?? ''}`}
      style={copied ? { color: 'var(--ok)' } : undefined}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
      {label != null && <span>{copied ? 'Copied!' : label}</span>}
    </button>
  )
}
