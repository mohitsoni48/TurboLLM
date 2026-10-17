import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { KeyRound } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { track } from '../lib/api'

/** Shown when the daemon answers 401 — i.e. it's exposed on the LAN and this client
 *  has no (or a stale) API key. Lets the user paste a key; the parent stores it and
 *  refetches. Replaces the misleading "lost connection" overlay for the auth case.
 *  `onDismiss` adds a "Not now", for when only a host-only setting asked for the key
 *  (auth-signal.ts's host-key signal) and the rest of the app works without one.
 *
 *  A modal Radix dialog of its own, portalled to <body>, not a plain fixed div in App's tree. A
 *  refusal can come from a request made inside a modal that stays open under the prompt (Models
 *  > Folders, the preset "Save preset" dialog, the Build guide's Re-check, the Requests drawer),
 *  and that modal sets body pointer-events: none, hides everything outside it (App's tree, the
 *  prompt with it) from the accessibility tree and pulls focus back into itself: the prompt
 *  showed but took no click, focus or typing, and only Escape or Back, closing the modal, got
 *  out. Opened later, the prompt is the top layer instead: it gets the pointer events, the focus
 *  trap and the Escape key, and the older modal is the one hidden, until the prompt closes.
 *  Radix's Root is used directly, not ui/dialog's: under that one's hardware-back handling, every
 *  open ui/dialog closes on the same popstate, so one Back would put off a "Not now" prompt and
 *  close the modal under it together, and a 401's prompt, which Back cannot close, would be left
 *  having spent its history entry. As before, Back with the prompt up closes the modal under it,
 *  if any, not the prompt. */
export function AuthGate({ onConnect, onDismiss }: { onConnect: (key: string) => void; onDismiss?: () => void }) {
  const [key, setKey] = useState('')
  const [submitted, setSubmitted] = useState(false)
  // What had focus when the prompt opened, often a control in the modal under it (the field or
  // button that sent the refused request): focus goes back there when the prompt closes. Radix's
  // modal content would focus its trigger instead, and the prompt has none, so focus would drop
  // to <body>.
  const [returnFocus] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))

  const submit = () => {
    const k = key.trim()
    if (!k) return
    track('developer', 'submit_auth_key')
    setSubmitted(true)
    onConnect(k)
  }

  return (
    // Escape is "Not now" when there is one; nothing else closes it. It covers the whole viewport,
    // so an outside pointerdown or focus can only be another layer's, a toast's, and must not put
    // off the prompt.
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onDismiss?.() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center px-6 focus:outline-none"
          style={{ background: 'color-mix(in srgb, var(--bg) 94%, transparent)' }}
          role="alertdialog"
          onEscapeKeyDown={(e) => { if (!onDismiss) e.preventDefault() }}
          onInteractOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            returnFocus?.focus()
          }}
        >
          <div className="w-full max-w-sm rounded-lg border border-border bg-panel p-5">
            <div className="mb-2 flex items-center gap-2 text-ink">
              <KeyRound size={16} />
              <DialogPrimitive.Title asChild>
                <span className="text-[15px] font-semibold">API key required</span>
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Description className="mb-3 text-[13px] text-muted">
              This TurboLLM is exposed on the network, so it needs an API key. Create one under{' '}
              <span className="text-ink">Customize → Connect → API keys</span> on the host machine, then paste it here.
            </DialogPrimitive.Description>
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
            {onDismiss && (
              <Button variant="ghost" className="mt-2 w-full" onClick={onDismiss}>
                Not now
              </Button>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
