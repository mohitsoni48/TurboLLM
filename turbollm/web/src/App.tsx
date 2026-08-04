import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { TooltipProvider } from './components/ui/tooltip'
import { Shell } from './components/Shell'
import { UnreachableOverlay } from './components/UnreachableOverlay'
import { AuthGate } from './components/AuthGate'
import { useStatus, useSettings } from './lib/queries'
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


export function App() {
  const statusQ = useStatus()
  const qc = useQueryClient()

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
          <Routes>
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
