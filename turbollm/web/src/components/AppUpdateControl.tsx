// The app-update surface (spec 29 B.3): ONE implementation, mounted twice.
//
// Before this, the only place an available update appeared was Settings → About, three
// clicks deep, and the only thing it offered was a command to go type in a terminal. That
// is the whole of complaint #3 ("existing users never update"). This component is the
// clickable version of it, and it is deliberately a single component used by both the
// NavRail (bottom-left, where the version already lives) and AboutSection — two mounts of
// one implementation, so the two surfaces cannot drift into disagreeing about whether an
// update exists or what pressing the button does.
//
// It is never a dead end. When the daemon reports an install method that cannot update
// itself (Docker, a source checkout, the desktop app, or an install it honestly could not
// classify), the dialog falls back to exactly what Settings showed before: the copyable
// command, plus a sentence saying why the button isn't there.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, Check, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'
import { applyAppUpdate, getAppUpdateProgress, track } from '../lib/api'
import { useAppUpdate, useAppUpdatePolicyMutation, useDismissAppUpdateMutation, useStatus, useSysInfo } from '../lib/queries'
import { isAndroidOs } from '../lib/platform'
import type { AppUpdate, UpdatePolicy } from '../lib/types'
import { Button } from './ui/button'
import { CopyButton } from './ui/copy-button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { toast } from './ui/sonner'

/** The manual command shown when the daemon is too old to report one (it predates spec 29
 *  B.1's install-method detection). The global-npm install is by far the most common, and
 *  this is exactly what Settings → About showed before this component existed. */
const FALLBACK_COMMAND = 'npm i -g turbollm'

const RELEASES_URL = 'https://github.com/mohitsoni48/TurboLLM/releases'

/** Give up waiting for the daemon to come back. Generous on purpose: the restart drains a
 *  loaded model first, which can take ~8s on its own, and the install in between is an npm
 *  registry round-trip on whatever connection the user has. Hitting this is not "the update
 *  failed" — it is "we stopped watching", and the dialog says so and offers the command. */
const RECONNECT_TIMEOUT_MS = 5 * 60_000

/** Versions we have already toasted about, for the life of this page. Module-level rather
 *  than component state because BOTH mounts of this component run the same effect — a
 *  per-component guard would fire the toast twice on every screen that shows both. */
const toasted = new Set<string>()

type Phase = 'idle' | 'starting' | 'restarting' | 'done' | 'failed'

/** Everything both mounts need, resolved once. Exported so the NavRail can decide whether
 *  to render anything at all without duplicating the visibility rules. */
export function useAppUpdateState(): {
  update: AppUpdate | undefined
  installed: string
  latest: string
  /** Show the update affordance? False on Android, when the check hasn't landed, when the
   *  policy is `off`, and when there is simply nothing newer. */
  visible: boolean
} {
  const { data: update } = useAppUpdate()
  const { data: status } = useStatus()
  const sys = useSysInfo().data
  const installed = update?.installed || status?.version || ''
  const latest = update?.latest ?? ''
  // Android's real update path is a Play Store release — there is no terminal to run a
  // command in and no npm on the device. Suppressed here exactly as AboutSection has
  // always suppressed it, rather than shown-and-disabled.
  const visible = !!update?.hasUpdate && !!latest && !isAndroidOs(sys?.os ?? '')
  return { update, installed, latest, visible }
}

/** The bottom-of-the-rail version slot (spec 29 B.3). With no update it renders exactly
 *  the plain version line NavRail has always shown; with one it becomes a clickable,
 *  accent-tinted pill. One component owning both states is what guarantees the rail can
 *  never show a stale version beside an update pill claiming a different one. */
export function AppUpdateRailSlot({ version }: { version: string }) {
  const { installed, latest, visible } = useAppUpdateState()
  const [open, setOpen] = useState(false)
  useUpdateToast(() => setOpen(true))

  if (!visible) return <span className="hidden text-[11px] text-faint xl:inline">{version}</span>

  return (
    <>
      <button
        type="button"
        onClick={() => {
          track('settings', 'open_app_update_from_nav')
          setOpen(true)
        }}
        aria-label={`Update available: v${installed} to v${latest}`}
        title={`TurboLLM v${latest} is available`}
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium transition-colors"
        style={{
          color: 'var(--accent)',
          background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
        }}
      >
        <ArrowUpCircle size={12} />
        {/* Below xl the rail is collapsed to icons and there is no room for two version
            strings, so the accent-tinted arrow carries the signal on its own. A bare accent
            DOT was the obvious alternative and is rejected: beside the engine state chip's
            dot immediately above it, a second dot reads as another status light rather than
            something to press. */}
        <span className="hidden xl:inline">{`v${installed} → v${latest}`}</span>
      </button>
      <AppUpdateDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/** The Settings → About body: the version row's companion. Same dialog, same state. */
export function AppUpdateSettingsBlock() {
  const { update, installed, latest, visible } = useAppUpdateState()
  const [open, setOpen] = useState(false)
  const policy = useAppUpdatePolicyMutation()
  const current: UpdatePolicy = update?.policy ?? 'notify'

  return (
    <>
      {visible ? (
        <div
          className="mt-2 flex flex-col gap-2 rounded-md border p-3"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent) 40%, var(--border))',
            background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
          }}
        >
          <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--accent)' }}>
            <ArrowUpCircle size={15} />
            TurboLLM v{latest} is available
          </div>
          <div className="text-[12px] text-muted">You're on v{installed}.</div>
          <div>
            <Button
              size="sm"
              onClick={() => {
                track('settings', 'open_app_update_from_settings')
                setOpen(true)
              }}
            >
              View update
            </Button>
          </div>
        </div>
      ) : update?.latest && !update.hasUpdate ? (
        // Checked successfully and current — a quiet confirmation, no call to action.
        <div className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-faint">
          <Check size={13} style={{ color: 'var(--ok)' }} />
          You're on the latest version
        </div>
      ) : null}

      {/* Update policy (spec 29 B.4) — the same off | notify | auto vocabulary the
          per-engine control uses, deliberately. */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
        <div>
          <div className="text-[14px] font-medium text-ink">Updates</div>
          <div className="text-[12px] text-muted">
            {current === 'off'
              ? "Don't check for new TurboLLM versions"
              : current === 'auto'
                ? 'Install new versions automatically when TurboLLM is idle'
                : 'Tell me when a new version is available'}
          </div>
        </div>
        <select
          value={current}
          onChange={(e) => {
            const next = e.target.value as UpdatePolicy
            track('settings', 'set_app_update_policy')
            policy.mutate(next)
          }}
          className="rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink outline-none"
        >
          <option value="off">Off</option>
          <option value="notify">Notify me</option>
          <option value="auto">Automatic</option>
        </select>
      </div>

      <AppUpdateDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/** One dismissible toast per new version per page load (spec 29 B.3: "never nagging twice
 *  for the same version"). The dismissed version is remembered DAEMON-side, not in this
 *  browser, so opening TurboLLM in a second browser doesn't re-ask. */
function useUpdateToast(onOpen: () => void) {
  const { update, latest, visible } = useAppUpdateState()
  const dismiss = useDismissAppUpdateMutation()
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  useEffect(() => {
    if (!visible || !latest) return
    if (update?.dismissedVersion === latest) return
    if (toasted.has(latest)) return
    toasted.add(latest)
    toast(`TurboLLM v${latest} is available`, {
      description: "You're running an older version.",
      action: { label: 'Update', onClick: onOpen },
      cancel: { label: 'Later', onClick: () => dismissRef.current.mutate(latest) },
      duration: 12_000,
    })
    // `onOpen` is a fresh closure each render and would re-run this effect forever if
    // depended on; the version is the real identity of "should we toast".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, latest, update?.dismissedVersion])
}

/** Current → new, what will happen, and the one button that does it. */
export function AppUpdateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { update, installed, latest } = useAppUpdateState()
  const dismiss = useDismissAppUpdateMutation()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<{ poll?: ReturnType<typeof setInterval>; giveUp?: ReturnType<typeof setTimeout> }>({})

  const canSelfUpdate = update?.canSelfUpdate ?? false
  const command = update?.command || FALLBACK_COMMAND
  const note = update?.note ?? ''

  const clearTimers = useCallback(() => {
    if (timers.current.poll) clearInterval(timers.current.poll)
    if (timers.current.giveUp) clearTimeout(timers.current.giveUp)
    timers.current = {}
  }, [])
  useEffect(() => clearTimers, [clearTimers])

  /** Watch the daemon through its own restart. Every failed request here is EXPECTED — the
   *  process is gone for a few seconds — so a rejection means "still restarting", never an
   *  error. The terminal answer comes from the RESTARTED daemon, which reports the outcome
   *  the updater helper recorded before relaunching it. */
  const watchRestart = useCallback(() => {
    clearTimers()
    setPhase('restarting')
    timers.current.poll = setInterval(() => {
      void getAppUpdateProgress()
        .then((p) => {
          if (p.state === 'done') {
            clearTimers()
            setPhase('done')
          } else if (p.state === 'failed') {
            clearTimers()
            setError(p.error || 'The update did not complete. TurboLLM is still on the previous version.')
            setPhase('failed')
          }
        })
        .catch(() => {
          /* daemon is down mid-restart — that's the normal path through this */
        })
    }, 1500)
    timers.current.giveUp = setTimeout(() => {
      clearTimers()
      setError("TurboLLM is taking longer than expected to come back. Check ~/.turbollm/update.log, or run the command below.")
      setPhase('failed')
    }, RECONNECT_TIMEOUT_MS)
  }, [clearTimers])

  const start = () => {
    track('settings', 'apply_app_update')
    setError(null)
    setPhase('starting')
    void applyAppUpdate()
      .then(() => watchRestart())
      .catch((e: unknown) => {
        // A refusal (a download in flight, a Code session running, an install method that
        // can't self-update) arrives here with the daemon's own sentence. Show it verbatim
        // — it says exactly what to do — rather than a generic failure.
        setError(e instanceof Error ? e.message : 'The update could not be started.')
        setPhase('failed')
      })
  }

  const busy = phase === 'starting' || phase === 'restarting'

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Never let the dialog be dismissed mid-restart: closing it would strand the user on
        // a page whose daemon is deliberately down, with nothing saying why.
        if (busy) return
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{phase === 'done' ? 'TurboLLM is up to date' : 'Update TurboLLM'}</DialogTitle>
          <DialogDescription>
            {phase === 'done' ? `Now running v${latest}.` : `v${installed} → v${latest}`}
          </DialogDescription>
        </DialogHeader>

        {phase === 'done' ? (
          <div className="flex items-center gap-2 text-[13px] text-ink">
            <Check size={15} style={{ color: 'var(--ok)' }} />
            The update was installed and TurboLLM restarted. Reload this page to pick up the new UI.
          </div>
        ) : busy ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <Loader2 size={15} className="animate-spin" />
              {phase === 'starting' ? 'Starting the update…' : 'Installing and restarting — TurboLLM will be back in a moment.'}
            </div>
            <div className="text-[12px] text-muted">
              Don't close this window. If anything goes wrong the previous version is left untouched.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {error ? (
              <div className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--err)' }}>
                <TriangleAlert size={15} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            {note ? <div className="text-[12px] text-muted">{note}</div> : null}

            {canSelfUpdate && phase !== 'failed' ? (
              <div className="text-[12px] text-muted">
                TurboLLM will install the new version and restart itself. Any loaded model is unloaded
                first, and chats are not affected.
              </div>
            ) : (
              // The never-a-dead-end fallback: exactly what Settings → About showed before
              // this component existed.
              <div className="flex flex-col gap-1.5">
                <div className="text-[12px] text-muted">Update it yourself:</div>
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5">
                  <code className="select-all font-mono text-[12px] text-ink">{command}</code>
                  <CopyButton text={command} screen="settings" />
                </div>
              </div>
            )}

            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-ink"
            >
              <ExternalLink size={12} />
              What's new in v{latest}
            </a>
          </div>
        )}

        <DialogFooter>
          {phase === 'done' ? (
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          ) : busy ? null : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  // "Later" is also the dismissal: it records this version so neither the
                  // toast nor a second prompt asks again for the same release.
                  if (latest) dismiss.mutate(latest)
                  onOpenChange(false)
                }}
              >
                Later
              </Button>
              {canSelfUpdate ? (
                <Button size="sm" onClick={start}>
                  Update &amp; restart
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
