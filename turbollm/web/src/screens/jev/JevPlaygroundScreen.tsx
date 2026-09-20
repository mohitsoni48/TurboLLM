// The Jev Playground — the Workspace's only surface while a Jev model is loaded
// (ADR-434 (b), (c), (i)(1), (i)(5)).
//
// A Jev model answers two different questions ("does this follow?" and "which of these?"), so
// the screen keeps a draft for each and never discards one to show the other. It holds no
// conversation, no history and no sidebar: there is exactly one thing to do here.
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Scale } from 'lucide-react'
import { ApiError, stopEngine, track } from '../../lib/api'
import { useModelLoader } from '../../lib/model-loader'
import { useModels, useStatus } from '../../lib/queries'
import type { JevStatus, ModelEntry, Status } from '../../lib/types'
import { CheckPanel } from './CheckPanel'
import { ChoosePanel } from './ChoosePanel'
import { JevHeader } from './JevHeader'
import { JevOutput, type JevView } from './JevOutput'
import { JEV_EXAMPLES } from './jev-examples'
import {
  checkDraftError,
  chooseDraftError,
  runCheck,
  runChoose,
  type CheckDraft,
  type ChooseDraft,
  type JevRun,
} from './jev-run'
import { SwitchModelMenu, switchToModel } from './SwitchModelMenu'

type JevMode = 'check' | 'choose'

const MODE_ACTION: Record<JevMode, string> = { check: 'jev_mode_check', choose: 'jev_mode_choose' }

const RUN_ACTION: Record<JevMode, string> = { check: 'jev_run_check', choose: 'jev_run_choose' }

const CHOOSE_EXPLAINER = 'Each option is checked as "The correct answer is: …" and ranked by entailment.'

const NOTICE = 'Chat, Code and Routines are unavailable while a Jev model is loaded.'

export function JevPlaygroundScreen() {
  const statusQ = useStatus()
  const modelsQ = useModels()
  const location = useLocation()
  const { requestLoad } = useModelLoader()

  const models = modelsQ.data?.models
  const jev = loadedJev(statusQ.data, models)

  const [mode, setMode] = useState<JevMode>('check')
  const [check, setCheck] = useState<CheckDraft>(firstCheckDraft)
  const [choose, setChoose] = useState<ChooseDraft>(firstChooseDraft)
  const [run, setRun] = useState<JevRun | null>(null)
  const [view, setView] = useState<JevView>('results')
  const [problem, setProblem] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [switchOpen, setSwitchOpen] = useState(false)
  const [exampleId, setExampleId] = useState(JEV_EXAMPLES.check[0].id)

  async function runDraft(next: JevMode, check_: CheckDraft, choose_: ChooseDraft, key: string) {
    const missing = next === 'check' ? checkDraftError(check_) : chooseDraftError(choose_)
    setProblem(missing)
    if (missing) return
    track('workspace', RUN_ACTION[next])
    setRunning(true)
    try {
      setRun(next === 'check' ? await runCheck(key, check_) : await runChoose(key, choose_))
    } catch (e) {
      setProblem(failureMessage(e))
    } finally {
      setRunning(false)
    }
  }

  // The listener is on the window so the shortcut works with the focus anywhere on the page,
  // and `latestRun` keeps it subscribed once instead of re-binding on every keystroke.
  const latestRun = useRef<() => void>(() => {})
  latestRun.current = () => { if (jev) void runDraft(mode, check, choose, jev.key) }
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      latestRun.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // One automatic run, when the model is first seen answering: the screen opens on an example,
  // and an example with no answer under it does not show what the model does.
  const greeted = useRef(false)
  useEffect(() => {
    if (greeted.current || jev?.state !== 'running') return
    greeted.current = true
    latestRun.current()
  }, [jev?.state])

  if (!jev) return null
  // The handlers below are hoisted past the guard, so they need the narrowed value by name.
  const current = jev

  function pickMode(next: JevMode) {
    track('workspace', MODE_ACTION[next])
    setMode(next)
    setProblem(null)
    setRun(null)
  }

  function pickExample(id: string) {
    track('workspace', 'jev_load_example')
    setExampleId(id)
    const example = JEV_EXAMPLES.check.find((e) => e.id === id)
    if (example) {
      const draft = { premise: example.premise, hypotheses: [...example.hypotheses] }
      setMode('check')
      setCheck(draft)
      setRun(null)
      void runDraft('check', draft, choose, current.key)
      return
    }
    const picked = JEV_EXAMPLES.choose.find((e) => e.id === id)
    if (!picked) return
    const draft = { question: picked.question, options: [...picked.options] }
    setMode('choose')
    setChoose(draft)
    setRun(null)
    void runDraft('choose', check, draft, current.key)
  }

  function pickModel(m: ModelEntry) {
    setSwitchOpen(false)
    void switchToModel(current, m, { stopEngine, requestLoad })
  }

  const template = models?.find((m) => m.key === jev.key)?.jev?.nliTemplate ?? null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl gap-4 px-4 py-4">
        <WorkspaceColumn />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {(location.state as { jevNotice?: boolean } | null)?.jevNotice && (
            <p className="text-[13px] text-muted">{NOTICE}</p>
          )}

          <JevHeader jev={jev} engine={activeEngine(statusQ.data)} onSwitch={() => setSwitchOpen((open) => !open)} />
          {switchOpen && <SwitchModelMenu current={jev} models={models ?? []} onPick={pickModel} />}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex w-fit rounded-md border border-border p-0.5" role="group" aria-label="Mode">
              {(['check', 'choose'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={mode === candidate}
                  onClick={() => pickMode(candidate)}
                  className={`rounded px-3 py-1 text-[13px] font-medium transition-colors ${
                    mode === candidate ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink'
                  }`}
                >
                  {candidate === 'check' ? 'Check' : 'Choose'}
                </button>
              ))}
            </div>
            <select
              aria-label="Example"
              value={exampleId}
              onChange={(e) => pickExample(e.target.value)}
              className="max-w-[210px] rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink"
            >
              {[...JEV_EXAMPLES.check, ...JEV_EXAMPLES.choose].map((example) => (
                <option key={example.id} value={example.id}>{example.label}</option>
              ))}
            </select>
          </div>

          {mode === 'check' ? (
            <>
              <CheckPanel value={check} onChange={setCheck} onRun={() => latestRun.current()} running={running} />
              {template && <p className="text-[12px] text-muted">{templateHint(template)}</p>}
            </>
          ) : (
            <>
              <ChoosePanel value={choose} onChange={setChoose} onRun={() => latestRun.current()} running={running} />
              <p className="text-[12px] text-muted">{CHOOSE_EXPLAINER}</p>
            </>
          )}

          {problem && <p className="text-[13px] text-err">{problem}</p>}
          <JevOutput run={run} view={view} onView={setView} origin={window.location.origin} />
        </div>
      </div>
    </div>
  )
}

/** The mockup's left rail: one item, and the reason the others are missing. Hidden on a phone,
 *  where the single column IS the answer to "where did everything go". */
function WorkspaceColumn() {
  return (
    <div className="hidden w-[150px] shrink-0 flex-col gap-2 md:flex">
      <span className="text-[12px] text-muted">Workspace</span>
      <span className="flex items-center gap-2 rounded-md bg-panel-2 px-2 py-1.5 text-[13px] font-medium text-ink">
        <Scale size={16} /> Jev Playground
      </span>
      <p className="text-[12px] leading-5 text-muted">Chat, Code and Routines are hidden while a Jev model is loaded.</p>
    </div>
  )
}

/** `status.jev` when the daemon says so; otherwise the loaded Jev model in the catalog — a
 *  remote-access token scoped to `models:use` cannot read /status at all (ADR-422, R8). */
function loadedJev(status: Status | undefined, models: ModelEntry[] | undefined): JevStatus | null {
  if (status?.jev) return status.jev
  if (status?.jev === null) return null
  const entry = models?.find((m) => m.jev && m.loaded)
  if (!entry?.jev) return null
  return { key: entry.key, name: entry.name, labels: entry.jev.labels, state: 'running', slot: 'primary' }
}

function activeEngine(status: Status | undefined): { name: string; kind: string } {
  return { name: status?.engine?.name ?? '', kind: status?.engine?.kind ?? '' }
}

/** The model's own template with its slots shown as ellipses, on one line. */
function templateHint(template: string): string {
  const filled = template.replaceAll('{premise}', '…').replaceAll('{hypothesis}', '…').replaceAll('\n', ' ')
  return `Sent as the model's own template: "${filled}"`
}

function failureMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : 'The request failed.'
}

function firstCheckDraft(): CheckDraft {
  const example = JEV_EXAMPLES.check[0]
  return { premise: example.premise, hypotheses: [...example.hypotheses] }
}

function firstChooseDraft(): ChooseDraft {
  const example = JEV_EXAMPLES.choose[0]
  return { question: example.question, options: [...example.options] }
}
