import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { track } from '../lib/api'

/** Shown when the daemon answers 401 — i.e. it's exposed on the LAN and this client
 *  has no (or a stale) API key. Lets the user paste a key; the parent stores it and
 *  refetches. Replaces the misleading "lost connection" overlay for the auth case. */
export function AuthGate({ onConnect }: { onConnect: (key: string) => void }) {
  const [key, setKey] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const submit = () => {
    const k = key.trim()
    if (!k) return
    track('developer', 'submit_auth_key')
    setSubmitted(true)
    onConnect(k)
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center px-6"
      style={{ background: 'color-mix(in srgb, var(--bg) 94%, transparent)' }}
      role="alertdialog"
      aria-label="API key required"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-panel p-5">
        <div className="mb-2 flex items-center gap-2 text-ink">
          <KeyRound size={16} />
          <span className="text-[15px] font-semibold">API key required</span>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          This TurboLLM is exposed on the network, so it needs an API key. Create one under{' '}
          <span className="text-ink">Developer</span> on the host machine, then paste it here.
        </p>
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="Paste API key"
          autoFocus
        />
        {submitted && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--warn)' }}>
            Still here? That key was rejected — double-check it and try again.
          </p>
        )}
        <Button className="mt-3 w-full" onClick={submit} disabled={!key.trim()}>
          Connect
        </Button>
      </div>
    </div>
  )
}
