import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, Download, Loader2, Terminal } from 'lucide-react'
import { useDownloadMutations, useDownloads, useModels, useStatus } from '../../../lib/queries'
import { loadModel, track, trackRecovery, trackRecoveryText } from '../../../lib/api'
import { useOnboardingMachine } from '../../../lib/onboarding/useOnboardingMachine'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step 5 — Load (spec 25 §4). Real progress: polls the actual download
 *  record, matches the finished file to its scanned `ModelEntry`, triggers a
 *  real `loadModel()` (auto-fit — spec 25 §6.2, never a tuned config here),
 *  and advances once `Status.model` is populated.
 *
 *  Known scope gap, called out rather than faked: the daemon does not yet
 *  expose a classified load-failure reason to the client on this path (no
 *  `lastLoadError` on `Status`), so a failed load surfaces the launch-command
 *  / Models-screen recovery only — not the full per-`FAIL_REASONS` matrix
 *  `recovery.ts` already models. Wiring that needs a small server-side
 *  addition (surfacing `classifyLoadFailure`'s result on `Status`), tracked as
 *  follow-up rather than invented here. */
export default function LoadStep({ onContinue, ctx }: StepComponentProps) {
  const navigate = useNavigate()
  const { advance, patchCtx, goToStep } = useOnboardingMachine()
  const downloadsQuery = useDownloads()
  const downloadMutations = useDownloadMutations()
  const modelsQuery = useModels()
  const statusQuery = useStatus()
  const [loadTriggered, setLoadTriggered] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const advancedRef = useRef(false)
  // A retry is only worth measuring once we know whether it WORKED, and that answer
  // arrives on a later render (the model comes up, or the download reaches a terminal
  // status). This holds the in-flight attempt until then — `onboarding_recovery`'s whole
  // point is the outcome, so reporting at click time records the question and never the
  // answer.
  //
  // `wasLoaded` and `leftError` are the guards that keep the outcome honest. Without
  // them the settle effect fires on the state that was ALREADY true when the button was
  // clicked: a model still loaded from earlier reads as an instant 'ok', and a download
  // record still sitting at 'error' (which is exactly why the retry button is on screen)
  // reads as an instant 'fail'. Either way the event would report a constant and measure
  // nothing — the precise failure mode this whole telemetry pass exists to remove.
  const pendingRecoveryRef = useRef<
    | { kind: 'load'; failure: string; action: string; wasLoaded: boolean }
    | { kind: 'download'; failureText: string; action: string; downloadId: string; leftError: boolean }
    | null
  >(null)

  // 'error' is excluded from BOTH `activeDownload` and `finishedDownload` — it is neither
  // still in flight nor a success, and matching it against the old `!== 'done' && !==
  // 'cancelled'` filter (which an 'error' status DOES satisfy) is exactly the bug: a
  // download that genuinely failed (checksum mismatch, dropped connection, a bad server
  // response) rendered as a permanently frozen "Downloading…" progress bar forever, no
  // error text, no retry — found live, driving a real download against the E2E fixture
  // through to a genuine checksum failure, not simulated.
  // Scoped to `ctx.expectedDownloadId` when ModelStep's real "Download this" flow set one
  // (`startDownload()`) — otherwise every download in history is a candidate, which is
  // still correct for the paths that never had an id to record (Discover handoff, whose
  // download happens on an entirely different screen with no onboarding ctx to write to;
  // a post-reload resume with no trail left). Found live: without this scoping, an older,
  // unrelated, already-loaded model's download record — still the most recent `.done` one
  // in history purely because THIS run's own download hadn't finished yet — got matched
  // instead, advancing the wizard to the wrong model while the real download was still in
  // flight.
  const relevantDownloads = ctx.expectedDownloadId
    ? downloadsQuery.data?.downloads.filter((d) => d.id === ctx.expectedDownloadId)
    : downloadsQuery.data?.downloads
  const activeDownload = relevantDownloads?.find((d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused')
  // Most-recent-first: `erroredDownload`/`finishedDownload` must reflect the LATEST event of
  // each kind, not just the first one `.find()` happens to hit in array order. Matters both
  // for which one wins below (a fresh failure must still surface even with an old, unrelated
  // success sitting earlier in the list — found live when this session's own new regression
  // test for the opposite case polluted a later test's download history) and for which
  // record `matchedEntry` loads (an old finished download from prior app use should never
  // outrank a fresh one this run actually triggered).
  const downloadsByRecency = [...(relevantDownloads ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const erroredDownload = downloadsByRecency.find((d) => d.status === 'error')
  const finishedDownload = downloadsByRecency.find((d) => d.status === 'done')
  // Gated on `!activeDownload` too, not just "a finished download exists": when something
  // is STILL actively downloading (the common case for the Discover-handoff/unscoped
  // fallback above, which has no id to pin the match to), an older, unrelated, already-
  // loaded model's `.done` record must not win just because it happens to be the most
  // recent SUCCESS in history — the thing actually in flight right now is almost always
  // what the user is waiting for. Found live, this exact wrong-match happened: a genuinely
  // new download was still 3s from finishing, and an older download from earlier in the
  // same session got matched and loaded instead, the instant Load mounted.
  const matchedEntry = finishedDownload && !activeDownload
    ? modelsQuery.data?.models.find((m) => finishedDownload.dest.endsWith(m.name) || m.path === finishedDownload.dest)
    : undefined

  const downloadPct = activeDownload && activeDownload.total > 0
    ? Math.round((activeDownload.received / activeDownload.total) * 100)
    : null

  useEffect(() => {
    if (finishedDownload && !ctx.downloadDone) patchCtx({ downloadDone: true })
  }, [finishedDownload, ctx.downloadDone, patchCtx])

  useEffect(() => {
    if (!matchedEntry || loadTriggered) return
    setLoadTriggered(true)
    // ModelStep's "use a model I already have" path (useExisting()) already AWAITS its
    // own real loadModel(entry.key) call before ever navigating here, and stamps
    // `ctx.expectedModelKey` with that exact key right before doing so. When
    // `matchedEntry` (independently derived above from the most-recent finished
    // download, which for an existing on-disk model is very often the SAME model —
    // it was almost certainly downloaded through TurboLLM at some point) resolves to
    // that identical key, the load already happened; firing loadModel() again here is
    // a redundant, wasteful SECOND `POST /api/v1/engine/start` for the model that's
    // already loading/loaded. Confirmed live via a real browser: two calls land ~10ms
    // apart, and Manager.load() has no "already running this exact model" short-
    // circuit on this manual path — the second call unconditionally stops and
    // restarts the engine that the first call just finished starting. Auto-fit
    // (ADR-190, no tuned config on the first load, spec 25 §6.2) still applies to the
    // one real load either way — this only skips the duplicate.
    if (ctx.expectedModelKey && ctx.expectedModelKey === matchedEntry.key) return
    loadModel(matchedEntry.key).catch(() => setLoadFailed(true))
  }, [matchedEntry, loadTriggered, ctx.expectedModelKey])

  // The specific key this run is actually waiting for — from ctx directly
  // when a step already knows it (ModelStep's "use existing model" path, no
  // download to match against), else from the download match above. Found by
  // an adversarial QA pass: without requiring a match, this effect advanced
  // the instant ANY model was already loaded in the engine — a leftover from
  // prior use, unrelated to what this run actually requested — while a
  // genuinely-requested download was still only ~6% complete in the
  // background.
  const expectedKey = ctx.expectedModelKey ?? matchedEntry?.key ?? null
  const loadedModel = statusQuery.data?.model

  // Second bug the re-verification pass found: a reload resets `ctx` to
  // INITIAL_CTX (only `currentStepId` survives, by this file's own deliberate
  // design — see useOnboardingMachine.tsx's header comment), but restores
  // `currentStepId` to 'load' from localStorage regardless. That combination
  // — landing on Load with `expectedModelKey` wiped and no download to match
  // either — can ONLY happen post-reload; during a normal in-session flow
  // ModelStep always sets one or the other before ever navigating here. When
  // it happens, `expectedKey` above is permanently null, so `isLoaded` could
  // never become true even though the daemon confirmed the model loaded
  // successfully and stayed running — the user was stuck on this screen
  // forever with only "Skip onboarding" (full exit) or Back available.
  // Trusting `Status.model` in exactly this no-trail-left case is an honest,
  // narrower version of the "any model counts" behaviour bug #3 removed:
  // it only engages when there is nothing left to compare against, never
  // when a real expectation or download is actually in flight.
  // `!ctx.expectedDownloadId` too: if ModelStep's real download flow stamped one, we are
  // DEFINITELY waiting on something even if the (possibly still-stale) downloads cache
  // hasn't caught up yet — "nothing to load" is never the right read in that case. Found
  // by an Opus release-review pass, live-traced: `ModelStep.startDownload()`'s raw
  // `enqueueDownload()` call doesn't invalidate the downloads query cache, so on the very
  // next render `relevantDownloads` can still reflect the pre-download empty list, making
  // this condition true for up to the ~2s until App.tsx's poll catches up — a full-screen
  // "Nothing to load yet" flash immediately after the user clicks Download, on the primary
  // happy path. See ModelStep.tsx's own fix (switched to the invalidating mutation) for the
  // other half of this.
  const resumedWithNoTrail = !ctx.expectedModelKey && !ctx.expectedDownloadId && !activeDownload && !finishedDownload && !erroredDownload
  const isLoaded = Boolean(
    loadedModel && ((expectedKey && loadedModel.key === expectedKey) || resumedWithNoTrail),
  )

  // The gap `resumedWithNoTrail` above never covered: it only ever resolves `isLoaded` to
  // TRUE (a model genuinely already loaded). When there is nothing to compare against AND
  // no model has loaded either — the exact shape of the Discover-handoff-and-resume path
  // (ModelStep's "pick a different model", ADR-338 Decision 6b's "highest-value E2E case"):
  // browse, download nothing, click "Resume setup" — the user lands here with no
  // expectedModelKey, no download of any kind, and no loaded model. `matchedEntry` stays
  // undefined forever, `loadTriggered` never becomes true, and the screen sits on "Loading
  // your model" / "Downloading" text with nothing actually happening, permanently — found
  // live by adversarial QA, a genuine dead end with no recovery affordance at all.
  //
  // Gated on both queries having actually SETTLED (`isSuccess`, not just `!isLoading`):
  // on a normal happy-path mount right after ModelStep's real `enqueueDownload()`, these
  // two queries haven't necessarily returned their first response yet, and an undefined
  // `.data` looks identical to "genuinely nothing exists" — without this gate, every real
  // download would risk a false "Nothing to load yet" flash before the poll catches up.
  const nothingToLoad = resumedWithNoTrail && !loadedModel && downloadsQuery.isSuccess && statusQuery.isSuccess

  // Auto-advance only the FIRST time this session reaches a genuinely loaded
  // model — gated on ctx.loadCompletedOnce, which lives in the shared machine
  // context and survives this component remounting. Without it, pressing
  // "← Back" from Payoff (a normal interaction now that Payoff no longer
  // exits the wizard immediately) landed here, re-ran this exact check,
  // found the same model still loaded, and instantly bounced forward again —
  // Back appeared to do nothing. Found by adversarial QA.
  useEffect(() => {
    if (isLoaded && !advancedRef.current && !ctx.loadCompletedOnce) {
      advancedRef.current = true
      patchCtx({ loadCompletedOnce: true })
      advance()
    }
  }, [isLoaded, ctx.loadCompletedOnce, advance, patchCtx])

  // Settle whichever recovery attempt is in flight, from OBSERVED state only.
  //
  // Load: the expected model actually coming up is 'ok'; landing back on the failure
  // screen is 'fail'. `wasLoaded` suppresses the case where something was already
  // loaded when the user clicked, which would otherwise report success for a retry
  // that never happened.
  //
  // Download: a resume is judged on the download RECORD reaching a terminal status,
  // not on the resume request being accepted. `resume.mutate` resolving only means the
  // daemon took the request — reporting 'ok' there would have made this event a
  // near-constant success, since that call essentially always succeeds. The record must
  // first leave 'error' (`leftError`), and only then does 'done' mean the remedy worked.
  //
  // The ref is cleared as it settles, so each attempt reports exactly once and a user
  // who retries three times before succeeding produces three honest rows — the most
  // informative shape this event has, and why it is per-action rather than once-only.
  useEffect(() => {
    const p = pendingRecoveryRef.current
    if (!p) return

    if (p.kind === 'load') {
      // `wasLoaded` means a model matching the expected key was ALREADY up when
      // Retry was pressed, so "it is up now" cannot distinguish a successful retry
      // from the state that preceded it. Report nothing rather than something:
      // settling 'fail' here (the only branch still reachable) would make every
      // such attempt a failure and bias the one metric that measures whether
      // recovery works. A missing row is honest; a wrong one is not.
      if (p.wasLoaded) return
      if (isLoaded) {
        pendingRecoveryRef.current = null
        trackRecovery(p.failure, p.action, 'ok')
      } else if (loadFailed) {
        pendingRecoveryRef.current = null
        trackRecovery(p.failure, p.action, 'fail')
      }
      return
    }

    const record = downloadsQuery.data?.downloads.find((dl) => dl.id === p.downloadId)
    if (!record) return
    // 'done' is checked BEFORE the leftError gate on purpose. useDownloads stops
    // polling once a download reaches 'done', so a resume that finishes between
    // two polls never shows an intermediate status — gating success on having
    // first observed the record leave 'error' would silently drop exactly the
    // fastest, most successful retries and skew the metric toward failure.
    if (record.status === 'done') {
      pendingRecoveryRef.current = null
      trackRecoveryText(p.failureText, p.action, 'ok')
      return
    }
    if (!p.leftError) {
      // Still showing the pre-retry failure; nothing has been attempted yet.
      if (record.status !== 'error') p.leftError = true
      return
    }
    if (record.status === 'error') {
      pendingRecoveryRef.current = null
      trackRecoveryText(p.failureText, p.action, 'fail')
    }
  }, [isLoaded, loadFailed, downloadsQuery.data])

  if (loadFailed) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Terminal size={20} className="text-red-400" />
          <h3 className="text-lg font-semibold text-ink">The load didn't finish</h3>
        </div>
        <p className="text-sm text-muted">
          Check the launch command and logs on the Models screen for what went wrong, or try a
          smaller quant.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              track('onboarding', 'take_recovery_action')
              // 'other' is honest here, not lazy: the daemon still does not surface a
              // classified load-failure reason on this path (see this file's header note
              // on the `lastLoadError` gap), so any more specific value would be invented.
              // Surfacing `classifyLoadFailure`'s result on Status is what upgrades it.
              pendingRecoveryRef.current = { kind: 'load', failure: 'other', action: 'retry', wasLoaded: isLoaded }
              setLoadFailed(false)
              setLoadTriggered(false)
            }}
            className="rounded-lg border border-accent bg-accent/10 text-accent px-4 py-2 text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => navigate('/models')}
            className="text-sm text-accent hover:text-accent-hover"
          >
            Open Models →
          </button>
        </div>
      </div>
    )
  }

  // Recency, not mere existence, decides which one wins: an errored record only blocks this
  // run when it's the MORE RECENT event. A plain `!finishedDownload` guard (an earlier version
  // of this fix) went too far the other way — an old, unrelated finished download could then
  // permanently mask a genuinely fresh failure that happened after it, which is just the
  // original bug's mirror image. Without any finishedDownload at all, the error always wins.
  if (erroredDownload && (!finishedDownload || finishedDownload.createdAt < erroredDownload.createdAt)) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <AlertTriangle size={20} className="text-red-400" />
          <h3 className="text-lg font-semibold text-ink">The download didn't finish</h3>
        </div>
        <p className="text-sm text-muted">{erroredDownload.error ?? 'The download failed.'}</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              track('onboarding', 'take_recovery_action')
              // The daemon's own error string goes back to the daemon to be classified
              // into an enum member there — it never becomes part of an event as text.
              const failureText = erroredDownload.error ?? ''
              pendingRecoveryRef.current = {
                kind: 'download',
                failureText,
                action: 'resume',
                downloadId: erroredDownload.id,
                leftError: false,
              }
              downloadMutations.resume.mutate(erroredDownload.id, {
                // Only the ERROR path is judged here. A rejected resume request is a
                // remedy that demonstrably did not work, and the record would stay at
                // 'error' forever, so the settle effect above would never fire. Success
                // is deliberately NOT reported here — see that effect for why.
                onError: () => {
                  const p = pendingRecoveryRef.current
                  if (p?.kind !== 'download' || p.downloadId !== erroredDownload.id) return
                  pendingRecoveryRef.current = null
                  trackRecoveryText(failureText, 'resume', 'fail')
                },
              })
            }}
            disabled={downloadMutations.resume.isPending}
            className="rounded-lg border border-accent bg-accent/10 text-accent px-4 py-2 text-sm font-medium hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {downloadMutations.resume.isPending ? 'Retrying…' : 'Retry'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/models')}
            className="text-sm text-accent hover:text-accent-hover"
          >
            Open Models →
          </button>
        </div>
      </div>
    )
  }

  if (nothingToLoad) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <AlertTriangle size={20} className="text-amber-400" />
          <h3 className="text-lg font-semibold text-ink">Nothing to load yet</h3>
        </div>
        <p className="text-sm text-muted">
          You haven't picked a model yet — head back and choose one, or download the
          recommended one.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => goToStep('model')}
            className="rounded-lg border border-accent bg-accent/10 text-accent px-4 py-2 text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Choose a model
          </button>
          <button
            type="button"
            onClick={() => navigate('/models')}
            className="text-sm text-accent hover:text-accent-hover"
          >
            Open Models →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <Loader2 size={20} className="text-accent animate-spin" />
        <h3 className="text-lg font-semibold text-ink">Loading your model</h3>
      </div>
      <p className="text-sm text-muted mb-6">
        Don't close this tab — your progress is saved either way.
      </p>

      <div className="space-y-3">
        <div className="flex items-center gap-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center">
            {finishedDownload ? (
              <Check size={16} className="text-accent" />
            ) : (
              <Download size={16} className="text-accent" />
            )}
          </div>
          <div className="flex-1">
            <span className="text-sm text-ink">
              {finishedDownload ? 'Download complete' : 'Downloading'}
            </span>
            {!finishedDownload && downloadPct !== null && (
              <div className="mt-1 h-1.5 rounded-full bg-panel overflow-hidden">
                <div className="h-full bg-accent rounded-full" style={{ width: `${downloadPct}%` }} />
              </div>
            )}
          </div>
        </div>

        <div className={`flex items-center gap-4 rounded-lg border p-3 ${loadTriggered ? 'border-accent/30 bg-accent/5' : 'border-transparent'}`}>
          <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center">
            {loadedModel ? <Check size={16} className="text-accent" /> : <Loader2 size={16} className={loadTriggered ? 'text-accent animate-spin' : 'text-muted'} />}
          </div>
          <span className={`text-sm ${loadTriggered ? 'text-ink' : 'text-faint'}`}>Loading into memory</span>
        </div>
      </div>

      {isLoaded && (
        <div className="pt-2">
          {/* Only reachable via Back after loadCompletedOnce is already true (the effect
              above already advanced past this once) — a manual way forward so the user is
              never stranded on a step that no longer auto-advances. The shell's own
              top-bar "Skip onboarding" and bottom "I don't need onboarding" already cover
              skip on every step — this used to render a THIRD, redundant "Skip onboarding"
              button here too, found live: two identically-labeled buttons on one screen. */}
          <button
            type="button"
            onClick={onContinue}
            className="rounded-lg border border-accent bg-accent/10 text-accent px-4 py-2 text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Continue
          </button>
        </div>
      )}
    </div>
  )
}
