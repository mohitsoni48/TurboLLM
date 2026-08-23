import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { TooltipProvider } from './components/ui/tooltip'
import { Shell } from './components/Shell'
import { UnreachableOverlay } from './components/UnreachableOverlay'
import { AuthGate } from './components/AuthGate'
import { useStatus, useSettings, useDownloads } from './lib/queries'
import { useUiStore } from './stores/ui'
import { useOnboardingState } from './lib/onboarding-queries'
import { ApiError, setAuthToken } from './lib/api'
import { subscribeCodeAuthNeeded, isCodeAuthNeeded } from './lib/auth-signal'
import { useRoutineNotificationPoller } from './lib/notify-routine'

// Route-level code splitting: each screen loads only when first navigated to.
const WorkspaceScreen = lazy(() => import('./screens/WorkspaceScreen').then((m) => ({ default: m.WorkspaceScreen })))
const CodeHomeScreen = lazy(() => import('./screens/code/CodeHomeScreen').then((m) => ({ default: m.CodeHomeScreen })))
const CodeSessionScreen = lazy(() => import('./screens/code/CodeSessionScreen').then((m) => ({ default: m.CodeSessionScreen })))
const RoutinesPanel = lazy(() => import('./screens/routines/RoutinesPanel').then((m) => ({ default: m.RoutinesPanel })))
const RoutineEditPage = lazy(() => import('./screens/routines/RoutineEditPage').then((m) => ({ default: m.RoutineEditPage })))
const ChatScreen = lazy(() => import('./screens/ChatScreen').then((m) => ({ default: m.ChatScreen })))
const SkillEditPage = lazy(() => import('./screens/skills/SkillEditPage').then((m) => ({ default: m.SkillEditPage })))
const AgentEditPage = lazy(() => import('./screens/agents/AgentEditPage').then((m) => ({ default: m.AgentEditPage })))
const ModelsScreen = lazy(() => import('./screens/ModelsScreen').then((m) => ({ default: m.ModelsScreen })))
const TokensScreen = lazy(() => import('./screens/TokensScreen').then((m) => ({ default: m.TokensScreen })))
const EnginesScreen = lazy(() => import('./screens/EnginesScreen').then((m) => ({ default: m.EnginesScreen })))
const DeveloperScreen = lazy(() => import('./screens/DeveloperScreen').then((m) => ({ default: m.DeveloperScreen })))
const CustomizeScreen = lazy(() => import('./screens/CustomizeScreen').then((m) => ({ default: m.CustomizeScreen })))
const SettingsScreen = lazy(() => import('./screens/SettingsScreen').then((m) => ({ default: m.SettingsScreen })))
const OnboardingScreen = lazy(() => import('./screens/onboarding/OnboardingScreen').then((m) => ({ default: m.OnboardingScreen })))

/** Minimal centered loader shown while a route chunk is fetching. */
function ScreenFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        className="h-6 w-6 animate-spin rounded-full border-2"
        style={{ borderColor: 'var(--muted)', borderTopColor: 'var(--ink)' }}
        aria-label="Loading"
      />
    </div>
  )
}

/** Onboarding entry predicate (spec 25 §3): redirects to `/onboarding` while
 *  it is unfinished AND the install has never once loaded a model
 *  successfully — `everLoadedModel` is server-authoritative (set only from a
 *  real successful load in `cli.ts`, never client-settable), so this cannot
 *  be tricked into re-showing the wizard by a stale local flag.
 *  While the query hasn't resolved yet, default to NOT redirecting — the same
 *  conservative-default convention `routinesEnabled` already uses above,
 *  so a slow first poll never flashes the wizard over a returning user's app.
 *
 *  `/models` is exempt. Caught by the E2E suite, not by typecheck or unit
 *  tests: ModelStep sends the user to `/models` from several DESIGNED,
 *  in-wizard exits — Pro's Discover handoff (ADR-338 Decision 6b, "the only
 *  branch that leaves the wizard by design"), "use models I already have",
 *  and "pick a different model". A blanket redirect bounced every one of
 *  those straight back to `/onboarding` before the user ever saw Discover —
 *  `onboarding.status` legitimately stays `pending` for all of them, since
 *  visiting Discover is part of finishing the wizard, not leaving it. */
function OnboardingGate({ shouldOnboard, children }: { shouldOnboard: boolean; children: ReactNode }) {
  const location = useLocation()
  const exempt = location.pathname === '/onboarding' || location.pathname === '/models'
  if (shouldOnboard && !exempt) {
    return <Navigate to="/onboarding" replace />
  }
  return <>{children}</>
}

/** ModelStep's Discover handoff (Pro, "pick a different model", "nothing fits this
 *  machine") sends the user to `/models?tab=discover` by design — the `/models`
 *  exemption above is exactly what lets that happen without bouncing straight back.
 *  But nothing then brings them back once they've actually started (and finished) a
 *  download there — found live: the download completed with no next action, leaving
 *  onboarding stranded mid-wizard. Watches for a download's `downloading`→`done`
 *  transition (not just "a done download exists", which would also fire on stale rows
 *  from a completely unrelated earlier session) and returns to `/onboarding` only while
 *  genuinely still mid-wizard and away from it. The wizard's own machine resumes from
 *  whatever step it saved to localStorage before the handoff — LoadStep matches the
 *  finished download on its own (see its header comment), no extra plumbing needed here. */
function useResumeOnboardingAfterDiscoverDownload(shouldOnboard: boolean) {
  const location = useLocation()
  const navigate = useNavigate()
  // `useDownloads()`'s own refetchInterval is tuned for DownloadsPanel's live progress bar —
  // it self-disables the moment nothing is 'downloading'/'queued', INCLUDING "nothing has
  // started yet." A small/fast download (or, found live, a raw API enqueue with no network
  // latency) can go directly from nonexistent straight to 'done' between two polls, so this
  // watcher needs its OWN unconditional poll — otherwise it may never observe the completion
  // at all, not just miss the transient 'active' state.
  const downloadsQ = useDownloads()
  useEffect(() => {
    if (!shouldOnboard) return
    const id = setInterval(() => void downloadsQ.refetch(), 2000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldOnboard])

  // Baseline, not transition-from-active: seeded with whatever is ALREADY 'done' on the
  // first observation (so a pre-existing completed download never fires this on mount),
  // then anything that becomes 'done' AFTER that baseline counts as "just finished" —
  // regardless of whether an 'active' state was ever actually observed for it.
  const seenDoneIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    const downloads = downloadsQ.data?.downloads
    if (!downloads) return
    const doneIds = downloads.filter((d) => d.status === 'done').map((d) => d.id)
    if (seenDoneIds.current === null) {
      seenDoneIds.current = new Set(doneIds)
      return
    }
    const justFinished = doneIds.some((id) => !seenDoneIds.current!.has(id))
    for (const id of doneIds) seenDoneIds.current.add(id)
    if (justFinished && shouldOnboard && location.pathname !== '/onboarding') {
      navigate('/onboarding')
    }
  }, [downloadsQ.data, shouldOnboard, location.pathname, navigate])
}

export function App() {
  const statusQ = useStatus()
  // Turbo Link (ADR-382): the daemon owns which machine this install is pointed at, so mirror
  // its value into the UI store on every status poll. Mounted HERE, once for the app's lifetime,
  // because the screens that read the selection unmount on navigation — hydrating in one of them
  // would make the value depend on which screen you happened to open first. The store ignores
  // this while a pick of its own is in flight.
  const syncRemoteModelId = useUiStore((s) => s.syncRemoteModelId)
  const daemonRemoteModel = statusQ.data?.selectedRemoteModel
  useEffect(() => {
    if (daemonRemoteModel === undefined) return // older daemon / not loaded yet — leave the cache alone
    syncRemoteModelId(daemonRemoteModel || null)
  }, [daemonRemoteModel, syncRemoteModelId])
  const qc = useQueryClient()
  const onboardingQ = useOnboardingState()
  const shouldOnboard =
    onboardingQ.data !== undefined &&
    onboardingQ.data.status === 'pending' &&
    !onboardingQ.data.everLoadedModel
  useResumeOnboardingAfterDiscoverDownload(shouldOnboard)

  // Routines is experimental, off by default (Settings → Experimental, config.ts's
  // `daemon.experimental.routines`). `?? false` while settings hasn't loaded yet is the
  // conservative default this whole gate is built around — the feature stays hidden until it's
  // positively confirmed on, never flashes on during a loading state.
  const settingsQ = useSettings().query
  const routinesEnabled = settingsQ.data?.experimental?.routines ?? false

  // Best-effort browser notifications for routine results (spec 20 §7). Mounted here so it lives
  // exactly once for the app's lifetime, independent of which route is showing. Reads the same
  // query keys Shell's nav badge and the Routines panel already poll, so it costs no extra
  // requests, and it is purely supplementary — the durable channel is the run history in the
  // Routines panel, which works whether or not a notification ever fires. Stops polling entirely
  // while the experimental flag is off.
  useRoutineNotificationPoller(undefined, routinesEnabled)

  // Count consecutive failed polls; show the unreachable overlay after 3 (spec 08 §1).
  const [failCount, setFailCount] = useState(0)
  const lastUpdated = useRef(0)
  useEffect(() => {
    if (statusQ.isSuccess) {
      setFailCount(0)
    } else if (statusQ.isError && statusQ.errorUpdatedAt !== lastUpdated.current) {
      lastUpdated.current = statusQ.errorUpdatedAt
      setFailCount((c) => c + 1)
    }
  }, [statusQ.isSuccess, statusQ.isError, statusQ.dataUpdatedAt, statusQ.errorUpdatedAt])

  const online = statusQ.isSuccess
  // A 401 isn't a lost connection — the daemon is up but (LAN-exposed) wants an API
  // key. Show the key prompt instead of the misleading "lost connection" overlay.
  // Code has its OWN always-on key gate independent of the global one (auth.ts's codeAuth) —
  // /status itself never 401s for it, so code-api.ts marks this separate signal instead.
  const codeAuthNeeded = useSyncExternalStore(subscribeCodeAuthNeeded, isCodeAuthNeeded)
  const needsAuth = (statusQ.isError && statusQ.error instanceof ApiError && statusQ.error.status === 401) || codeAuthNeeded

  // Latch the auth prompt once we've seen a 401, and keep it up until a poll finally
  // SUCCEEDS. Without this, a flaky LAN link (common on the remote machine where you're
  // pasting the key) flips an occasional poll from 401 → generic network error, which
  // would tear the dialog down, swap in the "lost connection" overlay, and wipe the
  // half-typed key. Sticky mount = the input keeps its value + focus while you type.
  const [authLatched, setAuthLatched] = useState(false)
  useEffect(() => {
    if (needsAuth) setAuthLatched(true)
    else if (statusQ.isSuccess) setAuthLatched(false)
  }, [needsAuth, statusQ.isSuccess])

  // While the key prompt is up, the "lost connection" overlay must yield to it.
  const unreachable = !authLatched && !needsAuth && failCount >= 3
  const version = statusQ.data?.version ? `v${statusQ.data.version}` : 'v0.0.0-dev'

  return (
    <TooltipProvider delayDuration={300}>
      <Shell status={statusQ.data} online={online} version={version}>
        <Suspense fallback={<ScreenFallback />}>
          <OnboardingGate shouldOnboard={shouldOnboard}>
          <Routes>
            <Route path="/onboarding" element={<OnboardingScreen />} />
            <Route path="/workspace" element={<Navigate to="/workspace/chat" replace />} />
            <Route path="/workspace/chat" element={<WorkspaceScreen />} />
            <Route path="/workspace/chat/:convId" element={<WorkspaceScreen />} />
            {/* Code — Workspace's second mode, not a separate nav item. Generally available
                (ADR-280) — no longer gated behind an experimental-feature flag. */}
            <Route path="/workspace/code" element={<CodeHomeScreen />} />
            <Route path="/workspace/code/:sessionId" element={<CodeSessionScreen />} />
            {/* Routines — Workspace's THIRD mode (spec 20 §2.1), a peer of Chat/Code rather than
                nested under Code — moved off /workspace/code/routines/* so the mode switch and
                the URL agree about what's selected. `/routines/new` is declared before
                `/routines/:routineId` for readability only: React Router ranks the static
                "new" segment above the dynamic one regardless of declaration order, so the
                create page is never swallowed by the detail route.
                Experimental (Settings → Experimental), off by default: every one of these routes
                bounces to Chat until `routinesEnabled` is true, same "hidden, not just unlinked"
                treatment as ConversationSidebar's mode tab and Shell's nav badge — a bookmarked or
                hand-typed URL must not be a backdoor around the flag. */}
            <Route path="/workspace/routines" element={routinesEnabled ? <RoutinesPanel /> : <Navigate to="/workspace/chat" replace />} />
            <Route path="/workspace/routines/new" element={routinesEnabled ? <RoutineEditPage /> : <Navigate to="/workspace/chat" replace />} />
            <Route path="/workspace/routines/:routineId" element={routinesEnabled ? <RoutineEditPage /> : <Navigate to="/workspace/chat" replace />} />
            {/* No back-compat redirect from /workspace/code/routines/* — this feature was built
                and has lived entirely within this dev cycle, never shipped under the old path,
                so there is nothing external pointing at it to preserve. */}
            {/* Back-compat: the old Workspace → Agent tab is gone; land on Chat instead. */}
            <Route path="/workspace/agent" element={<Navigate to="/workspace/chat" replace />} />
            <Route path="/workspace/agent/:convId" element={<Navigate to="/workspace/chat" replace />} />
            {/* Back-compat: /chat → Workspace; /chat/:convId stays a standalone view
                so existing LAN share links (baked as /chat/<id>) keep working. */}
            <Route path="/chat" element={<Navigate to="/workspace/chat" replace />} />
            <Route path="/chat/:convId" element={<ChatScreen />} />
            {/* Skills: managed from within Customize; this route is just the create/edit page. */}
            <Route path="/skills/:skillId" element={<SkillEditPage />} />
            {/* Agents: managed from within Customize; this route is just the create/edit page. */}
            <Route path="/agents/:agentId" element={<AgentEditPage />} />
            <Route path="/models" element={<ModelsScreen />} />
            <Route path="/usage" element={<TokensScreen />} />
            <Route path="/engines" element={<EnginesScreen />} />
            <Route path="/developer" element={<DeveloperScreen />} />
            <Route path="/customize" element={<CustomizeScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/workspace/chat" replace />} />
          </Routes>
          </OnboardingGate>
        </Suspense>
      </Shell>
      {authLatched && (
        <AuthGate
          onConnect={(key) => {
            setAuthToken(key)
            void qc.invalidateQueries()
          }}
        />
      )}
      {unreachable && <UnreachableOverlay />}
    </TooltipProvider>
  )
}
