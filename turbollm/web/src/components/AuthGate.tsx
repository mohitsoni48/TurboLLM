import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { KeyRound } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { track, type KeyCheck } from '../lib/api'

/** Shown when the daemon answers 401 — i.e. it's exposed on the LAN and this client
 *  has no (or a stale) API key. Lets the user paste a key; the parent checks it, then stores it
 *  and refetches. Replaces the misleading "lost connection" overlay for the auth case.
 *  `onDismiss` adds a "Not now", for when only a host-only setting or Code asked for the key
 *  (auth-signal.ts's signals) and the rest of the app works without one.
 *  `fullKeyNeeded` is for a key this browser has that a host-only change or Code did not take:
 *  most often one that works but cannot do what was asked (a remote-access token), or else one
 *  revoked since, which those refuse the same way. The prompt says a full API key is needed and
 *  that the key it has stays, rather than asking for "an API key" as if that one were wrong.
 *  It was shown once and cannot be recovered, so a pasted key replaces it only once the daemon
 *  takes the new one (App.tsx useKeyPrompt); `onConnect` resolves once that check is done, with
 *  what it said (api.ts KeyCheck), which picks the hint.
 *
 *  A modal Radix dialog of its own, portalled to <body>, not a plain fixed div in App's tree. A
 *  refusal can come from a request made inside a modal that stays open under the prompt (Models
 *  > Folders, the preset "Save preset" dialog, the Build guide's Re-check, the Requests drawer),
 *  and that modal sets body pointer-events: none, hides everything outside it (App's tree, the
 *  prompt with it) from the accessibility tree and pulls focus back into itself: the prompt
 *  showed but took no click, focus or typing, and only Escape or Back, closing the modal, got
 *  out. Opened later, the prompt is the top layer instead: it gets the pointer events, the focus
 *  trap and the Escape key, and the older modal is the one hidden, until the prompt closes.
 *  Radix's Root is used directly, not ui/dialog's: under that one's hardware-back handling, Back
 *  would go to the prompt, the newest overlay, and a 401's prompt, which Back cannot close, would
 *  be left having spent its history entry. As before, Back with the prompt up closes the modal
 *  under it, if any, not the prompt. */
export function AuthGate({ onConnect, onDismiss, fullKeyNeeded = false }: {
  onConnect: (key: string) => void | Promise<KeyCheck | void>
  onDismiss?: () => void
  fullKeyNeeded?: boolean
}) {
  const [key, setKey] = useState('')
  // What the last check said: null before any. A parent that says nothing (void) has stored the
  // key, so a prompt still up means it was rejected, as before the check.
  const [outcome, setOutcome] = useState<KeyCheck | null>(null)
  const [checking, setChecking] = useState(false)
  // What had focus when the prompt opened, often a control in the modal under it (the field or
  // button that sent the refused request): focus goes back there when the prompt closes. Radix's
  // modal content would focus its trigger instead, and the prompt has none, so focus would drop
  // to <body>.
  const [returnFocus] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))

  // The hint shows once the check is done, not while it runs: a key still being checked has not
  // been rejected. A key the check took is stored and closes the prompt once a request with it
  // succeeds, so it gets no hint: "rejected" showed there while that request was out.
  const submit = async () => {
    const k = key.trim()
    if (!k || checking) return
    track('developer', 'submit_auth_key')
    setChecking(true)
    let result: KeyCheck = 'unchecked'
    try {
      result = (await onConnect(k)) ?? 'refused'
    } finally {
      setChecking(false)
      setOutcome(result)
    }
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
              {fullKeyNeeded
                ? 'This needs a full API key. The key this browser has is not one (a remote-access token, say), or no longer works. Create one under '
                : 'This TurboLLM is exposed on the network, so it needs an API key. Create one under '}
              <span className="text-ink">Customize → Connect → API keys</span> on the host machine, then paste it here.
              {fullKeyNeeded && ' The key this browser has stays unless the new one is accepted.'}
            </DialogPrimitive.Description>
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="Paste API key"
              autoFocus
            />
            {outcome === 'refused' && !checking && (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--warn)' }}>
                {fullKeyNeeded
                  ? 'Still here? That key was rejected, so this browser keeps the one it has. Check that it is a full API key and try again.'
                  : 'Still here? That key was rejected — double-check it and try again.'}
              </p>
            )}
            {/* No answer about the key (a dropped connection, a tunnel's 502 while the daemon
                restarts): it was not stored, and nothing says it is wrong. */}
            {outcome === 'unchecked' && !checking && (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--warn)' }}>
                {fullKeyNeeded
                  ? 'Could not check that key, so this browser keeps the one it has. Try again in a moment.'
                  : 'Could not check that key, so it was not saved. Try again in a moment.'}
              </p>
            )}
            <Button className="mt-3 w-full" onClick={() => void submit()} disabled={!key.trim() || checking}>
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
