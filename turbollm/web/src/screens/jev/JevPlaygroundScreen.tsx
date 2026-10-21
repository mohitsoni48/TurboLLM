// The text classification playground (ADR-444) — the Workspace's only surface while a Jev model is
// loaded (ADR-434 (b), (c), (i)(1), (i)(5)) and a Workspace tab beside chat while a Laya model is, or
// while the library merely holds one (ADR-443; ADR-444, amended 2026-09-25). Rebuilt as the System
// One request itself (ADR-439): the two JSON editors ARE the body that gets posted, and the answers
// sit beside them.
//
// It holds no conversation and no history. Its left column is the Workspace's own: the mode control
// and the library's text classification models, so the page is a starting point, not only a destination.
//
// A run is the daemon's, not the page's (src/api/systemone-job.ts): Run starts it and the screen follows
// it, so closing, reloading or leaving the screen mid-run no longer throws it away. Leaving only stops
// the watching; the screen that comes back shows the run still going, or its answer and the request it
// answered. Only Cancel stops it.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { WorkspaceModeTabs } from '../../components/WorkspaceModeTabs'
import { Button } from '../../components/ui/button'
import { ApiError, stopEngine, track } from '../../lib/api'
import { cancelPlaygroundRun, getPlaygroundRun, startPlaygroundRun, type PlaygroundRun } from '../../lib/jev-api'
import { CHAT_PATH, hasTextClassifier, jevPresence, modelsOnceScanned, type JevPresence } from '../../lib/jev-mode'
import { isSystemOneModel } from '../../lib/model-kind'
import { useModelLoader, type LoadTarget } from '../../lib/model-loader'
import { servingElsewhere, useModelActions, useModels, useShowAllEngineModels, useStatus } from '../../lib/queries'
import { loadedSystemOneModel } from '../../lib/systemone-model'
import type { SystemOneRequest } from '../../lib/systemone-types'
import type { LoadedJev, ModelEntry, Status } from '../../lib/types'
import { useIsDesktop } from '../../lib/useIsDesktop'
import { AnswerList } from './AnswerList'
import { JevHeader } from './JevHeader'
import { JsonEditor, selectCls, TAB_INDENT_HINT } from './JsonEditor'
import { QuestionsField } from './QuestionsField'
import { ResponsePanel, type SystemOneRun } from './ResponsePanel'
import { SwitchModelMenu, ejectModel, switchToModel } from './SwitchModelMenu'
import { TextClassificationModelList } from './TextClassificationModelList'
import { draftFromRequest, draftRequest, type DraftProblem, type SystemOneDraft } from './systemone-draft'
import { SYSTEMONE_EXAMPLES } from './systemone-examples'

const NOTICE = 'Chat, Code and Routines are unavailable while a text classification model is loaded.'

const DRAFT_STORAGE_KEY = 'tllm.jev.systemone.draft'
const DRAFT_SAVE_DELAY_MS = 400

const DISCOVER_PATH = '/models?tab=discover'

/** How long to wait before each look at a running run: soon at first, since most runs take well under a
 *  second, then every half second until it ends. */
const POLL_DELAYS_MS = [100, 250, 500] as const

/** The run the screen followed is not the one the daemon holds: the daemon restarted (it keeps runs in
 *  memory only), or another tab cancelled it and started its own. */
const RUN_LOST = 'The server no longer has this run. It may have restarted; run it again.'

export function JevPlaygroundScreen() {
  const statusQ = useStatus()
  const modelsQ = useModels()
  const location = useLocation()
  const { requestLoad, pendingKey } = useModelLoader()
  const { eject } = useModelActions()
  const showAllEngineModels = useShowAllEngineModels()

  const models = modelsOnceScanned(modelsQ.data)
  const jev = loadedSystemOneModel(statusQ.data, models)
  const loadReturningToChat = useLoadReturningToChat(jevPresence(statusQ.data, models), requestLoad)

  const [draft, setDraft] = useState<SystemOneDraft>(() => readStoredDraft() ?? firstDraft())
  const [run, setRun] = useState<SystemOneRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  // The daemon run being followed, for Cancel; null while none is (or its start is still being posted).
  const [followedId, setFollowedId] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [exampleId, setExampleId] = useState(SYSTEMONE_EXAMPLES[0].id)
  const [switchOpen, setSwitchOpen] = useState(false)
  // False while the questions form shows a question or an option the text cannot hold (a repeated id
  // or option name): the run would ask less than the cards show.
  const [questionsFormValid, setQuestionsFormValid] = useState(true)

  useEffect(() => {
    const pendingSave = setTimeout(() => saveDraft(draft), DRAFT_SAVE_DELAY_MS)
    return () => clearTimeout(pendingSave)
  }, [draft])

  // One run at a time. The ref rather than the `running` state is the guard: the
  // shortcut and a click can both enter before a state update has landed.
  const inFlight = useRef(false)
  // And only the latest run asked may answer: an answer the screen has moved on from is dropped.
  const currentRun = useRef(0)
  // False once the screen has gone: following stops there, and nothing cancels the run.
  const watching = useRef(true)
  // Ends the wait before the next look at the run early (after a Cancel, so the screen does not read
  // Running… for another half second).
  const lookNow = useRef<() => void>(() => {})

  useEffect(() => {
    watching.current = true
    return () => { watching.current = false }
  }, [])

  // The run the daemon holds when the screen opens: one still going is followed, a finished one shows its
  // answer and the request it answered. The editors take that request only if they hold nothing the user
  // typed (empty, or still the first example); otherwise they are left alone. A daemon that cannot answer
  // leaves the screen as it opens without a run.
  useEffect(() => {
    let live = true
    getPlaygroundRun().then(
      (current) => {
        if (!live || inFlight.current || current.state === 'idle') return
        if (current.request) restoreDraftFrom(current.request)
        if (current.state === 'running') void follow(current, currentRun.current)
        else showOutcome(current)
      },
      () => {},
    )
    return () => { live = false }
    // Once, on mount: what the daemon holds when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function restoreDraftFrom(request: SystemOneRequest) {
    setDraft((current) => (holdsNothingTyped(current) ? draftFromRequest(request) : current))
  }

  /** What a run that has ended leaves on screen. A cancelled one leaves the answers that were there (and
   *  clears a "run already in progress" line about the run it followed). */
  function showOutcome(ended: PlaygroundRun) {
    if (ended.state === 'done' && ended.request && ended.response) {
      setRun({ request: ended.request, response: ended.response, ms: durationOf(ended) })
      setError(null)
    } else if (ended.state === 'error') {
      setError(ended.error?.message ?? 'The request failed.')
    } else if (ended.state === 'cancelled') {
      setError(null)
      setCancelled(true)
    }
  }

  /** Watch the daemon's run until it ends, then show how it ended if the screen still wants it (`asked`). */
  async function follow(started: PlaygroundRun, asked: number) {
    inFlight.current = true
    setRunning(true)
    setFollowedId(started.id ?? null)
    let current = started
    for (let look = 0; current.state === 'running'; look++) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_DELAYS_MS[Math.min(look, POLL_DELAYS_MS.length - 1)])
        lookNow.current = () => { clearTimeout(timer); resolve() }
      })
      if (!watching.current) return
      try {
        const seen = await getPlaygroundRun()
        current = seen.id === started.id ? seen : { state: 'error', error: { code: 'run_lost', message: RUN_LOST } }
      } catch (e) {
        // A daemon that does not answer for a moment (a dropped connection) is waited for; one that refuses is not.
        if (e instanceof ApiError) current = { state: 'error', error: { code: e.code, message: e.message } }
      }
    }
    inFlight.current = false
    setRunning(false)
    setFollowedId(null)
    if (asked === currentRun.current) showOutcome(current)
  }

  async function runDraft(key: string) {
    if (inFlight.current || !questionsFormValid) return
    const drafted = draftRequest(key, draft)
    if (!drafted.ok) return
    const asked = ++currentRun.current
    inFlight.current = true
    setRunning(true)
    setError(null)
    setCancelled(false)
    try {
      await follow(await startPlaygroundRun(drafted.request), asked)
    } catch (e) {
      inFlight.current = false
      setRunning(false)
      if (asked !== currentRun.current) return
      setError(failureMessage(e))
      // Another tab or device's run holds the daemon's one run: say so, and follow that run as opening the
      // screen would, so Run comes back once it ends.
      if (e instanceof ApiError && e.code === 'run_in_progress') {
        const current = await getPlaygroundRun().catch(() => null)
        if (current?.state === 'running' && watching.current && !inFlight.current) void follow(current, asked)
      }
    }
  }

  async function cancelRun() {
    if (followedId === null) return
    try {
      await cancelPlaygroundRun(followedId)
    } catch (e) {
      setError(failureMessage(e))
      return
    }
    lookNow.current()
  }

  // The listener is on the window so the shortcut works with the focus anywhere on the page,
  // and `latestRun` keeps it subscribed once instead of re-binding on every keystroke. The
  // model-running check lives here, so the shortcut sends nothing while the model is loading.
  const latestRun = useRef<() => void>(() => {})
  latestRun.current = () => { if (jev?.state === 'running') void runDraft(jev.key) }
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      latestRun.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Nothing to catch: a refused eject and a refused load both report themselves as a toast.
  function loadModel(m: ModelEntry) {
    void switchToModel(jev, m, { stopEngine, requestLoad })
  }

  const modelList = (
    <TextClassificationModelList
      models={models ?? []}
      current={jev}
      pendingKey={pendingKey}
      showAllEngineModels={showAllEngineModels}
      onLoad={loadModel}
      onEject={(m) => void ejectModel(m, { stopEngine: eject.mutateAsync })}
    />
  )

  if (!jev) {
    if (models !== undefined && !hasTextClassifier(statusQ.data, models)) return null
    return (
      <PlaygroundColumns modelList={modelList}>
        {models === undefined ? <LoadingModels /> : <NothingLoaded modelList={modelList} />}
      </PlaygroundColumns>
    )
  }

  const drafted = draftRequest(jev.key, draft)
  const problems = drafted.ok ? [] : drafted.problems

  /** What is on screen stops being the answer to what the editors now ask. */
  function dropCurrentRun() {
    currentRun.current += 1
    setRun(null)
    setCancelled(false)
  }

  // Loading an example replaces the draft and never runs it. The run in flight, if any, is not
  // cancelled (Cancel does that): it settles unseen, and Run waits for it.
  function pickExample(id: string) {
    const example = SYSTEMONE_EXAMPLES.find((candidate) => candidate.id === id)
    if (!example) return
    track('workspace', 'jev_load_example')
    setExampleId(id)
    setDraft({ stateText: example.stateText, questionsText: example.questionsText })
    setError(null)
    dropCurrentRun()
  }

  function pickModel(m: ModelEntry) {
    setSwitchOpen(false)
    const load = isSystemOneModel(m) ? requestLoad : loadReturningToChat
    void switchToModel(jev, m, { stopEngine, requestLoad: load })
  }

  return (
    <PlaygroundColumns modelList={modelList}>
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4">
        {(location.state as { takeoverNotice?: boolean } | null)?.takeoverNotice && (
          <p className="text-[13px] text-muted">{NOTICE}</p>
        )}

        <JevHeader jev={jev} engine={engineOf(jev, statusQ.data)} onSwitch={() => setSwitchOpen((open) => !open)} />
        {switchOpen && <SwitchModelMenu current={jev} models={models ?? []} onPick={pickModel} showAllEngineModels={showAllEngineModels} />}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section aria-label="Request" className="flex min-w-0 flex-col gap-3">
            <p className="font-mono text-[12px] text-muted">POST /v1/systemone</p>
            <JsonEditor
              id="jev-state"
              label="state"
              mode="json-or-text"
              caption={`JSON object or array, or plain text. ${TAB_INDENT_HINT}`}
              value={draft.stateText}
              onChange={(next) => setDraft((d) => ({ ...d, stateText: next }))}
              problem={problems.find(isStateProblem)?.message}
            />
            <QuestionsField
              value={draft.questionsText}
              onChange={(next) => setDraft((d) => ({ ...d, questionsText: next }))}
              problem={problems.find(isQuestionsProblem)?.message}
              onFormValidityChange={setQuestionsFormValid}
            />
            {problems.filter(isRequestProblem).map((problem) => (
              <p key={problem.field} role="alert" className="text-[13px] text-err">
                {problem.message}
              </p>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                aria-keyshortcuts="Meta+Enter Control+Enter"
                disabled={running || problems.length > 0 || !questionsFormValid || jev.state !== 'running'}
                onClick={() => latestRun.current()}
              >
                {running ? 'Running…' : 'Run'}
              </Button>
              {running && followedId !== null && (
                <Button type="button" variant="outline" onClick={() => void cancelRun()}>
                  Cancel
                </Button>
              )}
              <span className="text-[12px] text-muted">⌘/Ctrl+Enter</span>
              <select
                aria-label="Example"
                value={exampleId}
                onChange={(e) => pickExample(e.target.value)}
                className={selectCls}
              >
                {SYSTEMONE_EXAMPLES.map((example) => (
                  <option key={example.id} value={example.id}>{example.label}</option>
                ))}
              </select>
            </div>
          </section>

          <section aria-label="Response" className="flex min-w-0 flex-col gap-3">
            {error && (
              <p role="alert" className="text-[13px] text-err">
                {error}
              </p>
            )}
            <AnswerList answers={run?.response.answers ?? null} stale={running && run !== null} laya={jev.checkpoints !== undefined} />
            <ResponsePanel run={run} origin={window.location.origin} />
            <p role="status" className="sr-only">{announcementOf({ running, error, run, cancelled })}</p>
          </section>
        </div>
      </div>
    </PlaygroundColumns>
  )
}

type RequestLoad = ReturnType<typeof useModelLoader>['requestLoad']

/** A chat model picked in Switch model takes the Workspace back to Chat (ADR-434 (i)(5)), but only once the gate lets
 *  it stay there: until the chat model has replaced a Jev model, the gate sends /workspace/chat straight back here. A
 *  refused load leaves the playground where it is. */
function useLoadReturningToChat(presence: JevPresence, requestLoad: RequestLoad): (target: LoadTarget) => void {
  const navigate = useNavigate()
  const [returningToChat, setReturningToChat] = useState(false)
  useEffect(() => {
    if (returningToChat && presence !== 'loaded') navigate(CHAT_PATH)
  }, [returningToChat, presence, navigate])
  return (target) => {
    setReturningToChat(true)
    requestLoad(target, { onError: () => setReturningToChat(false) })
  }
}

/** The playground's place in the Workspace: on a desktop, the same left column as the other Workspace modes; on a
 *  phone, where there is no room for one, the mode control on top and the model list behind Switch model. */
function PlaygroundColumns({ modelList, children }: { modelList: ReactNode; children: ReactNode }) {
  const isDesktop = useIsDesktop()
  if (!isDesktop) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="px-4 pt-4">
          <WorkspaceModeTabs />
        </div>
        {children}
      </div>
    )
  }
  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex w-56 shrink-0 flex-col border-r border-border bg-panel-2">
        <div className="px-3 pt-3">
          <WorkspaceModeTabs />
        </div>
        {modelList}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

/** With nothing loaded there is no header and so no Switch model on a phone: the list moves into the page. */
function NothingLoaded({ modelList }: { modelList: ReactNode }) {
  const isDesktop = useIsDesktop()
  return (
    <CentredStatus>
      <div className="flex flex-col gap-1">
        <p className="text-[13px] text-ink">No text classification model is loaded.</p>
        <p className="text-[13px] text-muted">Load one from the list to try it.</p>
      </div>
      <Link to={DISCOVER_PATH} className="w-fit text-[13px] text-accent hover:underline">
        Find one in Discover
      </Link>
      {!isDesktop && <div className="w-full rounded-md border border-border text-left">{modelList}</div>}
    </CentredStatus>
  )
}

function LoadingModels() {
  return (
    <CentredStatus>
      <p className="text-[13px] text-muted">Loading models…</p>
    </CentredStatus>
  )
}

/** Centred in the pane and announced, as the chat screen's own empty state is. */
function CentredStatus({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="mx-auto flex min-h-[60vh] max-w-6xl flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      {children}
    </div>
  )
}

/** The engine answering: a Laya model always runs on the Laya engine, whichever engine is active (ADR-443). A Jev
 *  model in the primary runs on the engine the primary runs, which need not be the active one: an engine install or
 *  Enable activates another without stopping the model, and the header named the active engine beside the model's
 *  state. One in a pool slot keeps the engine that loaded it, which the status does not name, so the header names
 *  none rather than the active one; nor for a slot it cannot tell (the catalog fallback). */
function engineOf(model: LoadedJev, status: Status | undefined): { name: string; kind: string } {
  if (model.checkpoints) return { name: 'Laya', kind: 'laya' }
  if (model.slot !== 'primary') return { name: '', kind: '' }
  return primaryEngine(status)
}

function primaryEngine(status: Status | undefined): { name: string; kind: string } {
  const elsewhere = servingElsewhere(status)
  if (elsewhere) return { name: elsewhere, kind: status?.engine?.servingKind ?? '' }
  return { name: status?.engine?.name ?? '', kind: status?.engine?.kind ?? '' }
}

function failureMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : 'The request failed.'
}

/** What a screen reader hears about the run. A failed run says nothing here: the alert carries it,
 *  and the answers still on screen belong to an earlier run. */
function announcementOf({ running, error, run, cancelled }: { running: boolean; error: string | null; run: SystemOneRun | null; cancelled: boolean }): string {
  if (running) return 'The request is running.'
  if (cancelled) return 'The run was cancelled.'
  if (error !== null || run === null) return ''
  const answered = Object.keys(run.response.answers).length
  return `Answered ${answered} ${answered === 1 ? 'question' : 'questions'} in ${run.ms} ms.`
}

function firstDraft(): SystemOneDraft {
  const { stateText, questionsText } = SYSTEMONE_EXAMPLES[0]
  return { stateText, questionsText }
}

/** Empty, or still the first example the screen opens on: nothing a returning run's request would overwrite. */
function holdsNothingTyped(draft: SystemOneDraft): boolean {
  const first = firstDraft()
  const empty = draft.stateText.trim() === '' && draft.questionsText.trim() === ''
  return empty || (draft.stateText === first.stateText && draft.questionsText === first.questionsText)
}

/** How long the daemon took, start to end, as the footer reports it. */
function durationOf(ended: PlaygroundRun): number {
  const ms = Date.parse(ended.finishedAt ?? '') - Date.parse(ended.startedAt ?? '')
  return Number.isFinite(ms) && ms >= 0 ? ms : 0
}

/** The draft the user left, or null when there is none worth showing: a private window or blocked
 *  site data must not break the screen, and neither must a value someone else wrote there. */
function readStoredDraft(): SystemOneDraft | null {
  try {
    const stored = localStorage.getItem(DRAFT_STORAGE_KEY)
    return stored === null ? null : draftFrom(JSON.parse(stored))
  } catch {
    return null
  }
}

function draftFrom(value: unknown): SystemOneDraft | null {
  if (typeof value !== 'object' || value === null) return null
  const { stateText, questionsText } = value as Record<string, unknown>
  if (typeof stateText !== 'string' || typeof questionsText !== 'string') return null
  return { stateText, questionsText }
}

function saveDraft(draft: SystemOneDraft) {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // A refused write only means the draft is not remembered: the editors keep working.
  }
}

const isStateProblem = (problem: DraftProblem): boolean => problem.field === 'state'

const isQuestionsProblem = (problem: DraftProblem): boolean => problem.field.startsWith('questions')

/** A fault in the request as a whole (its size, its model): neither editor owns it, so the screen does. */
const isRequestProblem = (problem: DraftProblem): boolean => !isStateProblem(problem) && !isQuestionsProblem(problem)
