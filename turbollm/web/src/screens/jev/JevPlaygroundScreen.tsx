// The Jev Playground — the Workspace's only surface while a Jev model is loaded
// (ADR-434 (b), (c), (i)(1), (i)(5)), rebuilt as the System One request itself (ADR-439): the two
// JSON editors ARE the body that gets posted, and the answers sit beside them.
//
// It holds no conversation, no history and no sidebar: there is exactly one thing to do here.
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { ApiError, stopEngine, track } from '../../lib/api'
import { systemone } from '../../lib/jev-api'
import { useModelLoader } from '../../lib/model-loader'
import { useModels, useStatus } from '../../lib/queries'
import type { LoadedJev, ModelEntry, Status } from '../../lib/types'
import { AnswerList } from './AnswerList'
import { JevHeader } from './JevHeader'
import { JsonEditor } from './JsonEditor'
import { ResponsePanel, type SystemOneRun } from './ResponsePanel'
import { SwitchModelMenu, switchToModel } from './SwitchModelMenu'
import { draftRequest, type DraftProblem, type SystemOneDraft } from './systemone-draft'
import { SYSTEMONE_EXAMPLES } from './systemone-examples'

const NOTICE = 'Chat, Code and Routines are unavailable while a Jev model is loaded.'

const DRAFT_STORAGE_KEY = 'tllm.jev.systemone.draft'
const DRAFT_SAVE_DELAY_MS = 400

export function JevPlaygroundScreen() {
  const statusQ = useStatus()
  const modelsQ = useModels()
  const location = useLocation()
  const { requestLoad } = useModelLoader()

  const models = modelsQ.data?.models
  const jev = loadedJev(statusQ.data, models)

  const [draft, setDraft] = useState<SystemOneDraft>(() => readStoredDraft() ?? firstDraft())
  const [run, setRun] = useState<SystemOneRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [exampleId, setExampleId] = useState(SYSTEMONE_EXAMPLES[0].id)
  const [switchOpen, setSwitchOpen] = useState(false)

  useEffect(() => {
    const pendingSave = setTimeout(() => saveDraft(draft), DRAFT_SAVE_DELAY_MS)
    return () => clearTimeout(pendingSave)
  }, [draft])

  // One run at a time. The ref rather than the `running` state is the guard: the
  // shortcut and a click can both enter before a state update has landed.
  const inFlight = useRef(false)
  // And only the latest run asked may answer: an answer the screen has moved on from is dropped.
  const currentRun = useRef(0)

  async function runDraft(key: string) {
    if (inFlight.current) return
    const drafted = draftRequest(key, draft)
    if (!drafted.ok) return
    const asked = ++currentRun.current
    inFlight.current = true
    setRunning(true)
    setError(null)
    const started = performance.now()
    try {
      const response = await systemone(drafted.request)
      const ms = Math.round(performance.now() - started)
      if (asked === currentRun.current) setRun({ request: drafted.request, response, ms })
    } catch (e) {
      if (asked === currentRun.current) setError(failureMessage(e))
    } finally {
      inFlight.current = false
      setRunning(false)
    }
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

  if (!jev) return null
  // The handlers below are hoisted past the guard, so they need the narrowed value by name.
  const current = jev

  const drafted = draftRequest(jev.key, draft)
  const problems = drafted.ok ? [] : drafted.problems

  /** What is on screen stops being the answer to what the editors now ask. */
  function dropCurrentRun() {
    currentRun.current += 1
    setRun(null)
  }

  // Loading an example replaces the draft and never runs it. The run in flight, if any, is not
  // cancelled (there is nothing to cancel it with): it settles unseen, and Run waits for it.
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
    // Nothing to catch: a refused eject and a refused load both report themselves as a toast.
    void switchToModel(current, m, { stopEngine, requestLoad })
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4">
        {(location.state as { jevNotice?: boolean } | null)?.jevNotice && (
          <p className="text-[13px] text-muted">{NOTICE}</p>
        )}

        <JevHeader jev={jev} engine={activeEngine(statusQ.data)} onSwitch={() => setSwitchOpen((open) => !open)} />
        {switchOpen && <SwitchModelMenu current={jev} models={models ?? []} onPick={pickModel} />}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section aria-label="Request" className="flex min-w-0 flex-col gap-3">
            <p className="font-mono text-[12px] text-muted">POST /v1/systemone</p>
            <JsonEditor
              id="jev-state"
              label="state"
              mode="json-or-text"
              caption="JSON object or array, or plain text."
              value={draft.stateText}
              onChange={(next) => setDraft((d) => ({ ...d, stateText: next }))}
              problem={problems.find(isStateProblem)?.message}
            />
            <JsonEditor
              id="jev-questions"
              label="questions"
              mode="json"
              value={draft.questionsText}
              onChange={(next) => setDraft((d) => ({ ...d, questionsText: next }))}
              problem={problems.find(isQuestionsProblem)?.message}
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
                disabled={running || problems.length > 0 || jev.state !== 'running'}
                onClick={() => latestRun.current()}
              >
                {running ? 'Running…' : 'Run'}
              </Button>
              <span className="text-[12px] text-muted">⌘/Ctrl+Enter</span>
              <select
                aria-label="Example"
                value={exampleId}
                onChange={(e) => pickExample(e.target.value)}
                className="max-w-[210px] rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink"
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
            <AnswerList answers={run?.response.answers ?? null} stale={running && run !== null} />
            <ResponsePanel run={run} origin={window.location.origin} />
            <p role="status" className="sr-only">{announcementOf({ running, error, run })}</p>
          </section>
        </div>
      </div>
    </div>
  )
}

/** `status.jev` when the daemon says so; otherwise the loaded Jev model in the catalog — a
 *  remote-access token scoped to `models:use` cannot read /status at all (ADR-422). */
function loadedJev(status: Status | undefined, models: ModelEntry[] | undefined): LoadedJev | null {
  if (status?.jev) return status.jev
  if (status?.jev === null) return null
  const entry = models?.find((m) => m.jev && m.loaded)
  if (!entry?.jev) return null
  return { key: entry.key, name: entry.name, labels: entry.jev.labels, state: 'running', slot: null }
}

function activeEngine(status: Status | undefined): { name: string; kind: string } {
  return { name: status?.engine?.name ?? '', kind: status?.engine?.kind ?? '' }
}

function failureMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : 'The request failed.'
}

/** What a screen reader hears about the run. A failed run says nothing here: the alert carries it,
 *  and the answers still on screen belong to an earlier run. */
function announcementOf({ running, error, run }: { running: boolean; error: string | null; run: SystemOneRun | null }): string {
  if (running) return 'The request is running.'
  if (error !== null || run === null) return ''
  const answered = Object.keys(run.response.answers).length
  return `Answered ${answered} ${answered === 1 ? 'question' : 'questions'} in ${run.ms} ms.`
}

function firstDraft(): SystemOneDraft {
  const { stateText, questionsText } = SYSTEMONE_EXAMPLES[0]
  return { stateText, questionsText }
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
