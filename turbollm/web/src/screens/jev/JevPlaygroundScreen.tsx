// The Jev Playground — the Workspace's only surface while a Jev model is loaded
// (ADR-434 (b), (c), (i)(1), (i)(5)), rebuilt as the System One request itself (ADR-439): the two
// JSON editors ARE the body that gets posted, and the answers sit beside them.
//
// It holds no conversation, no history and no sidebar: there is exactly one thing to do here.
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { stopEngine } from '../../lib/api'
import { useModelLoader } from '../../lib/model-loader'
import { useModels, useStatus } from '../../lib/queries'
import type { LoadedJev, ModelEntry, Status } from '../../lib/types'
import { AnswerList } from './AnswerList'
import { JevHeader } from './JevHeader'
import { JsonEditor } from './JsonEditor'
import { ResponsePanel } from './ResponsePanel'
import { SwitchModelMenu, switchToModel } from './SwitchModelMenu'
import { draftRequest, type DraftProblem, type SystemOneDraft } from './systemone-draft'
import { SYSTEMONE_EXAMPLES } from './systemone-examples'

const NOTICE = 'Chat, Code and Routines are unavailable while a Jev model is loaded.'

export function JevPlaygroundScreen() {
  const statusQ = useStatus()
  const modelsQ = useModels()
  const location = useLocation()
  const { requestLoad } = useModelLoader()

  const models = modelsQ.data?.models
  const jev = loadedJev(statusQ.data, models)

  const [draft, setDraft] = useState<SystemOneDraft>(firstDraft)
  const [switchOpen, setSwitchOpen] = useState(false)

  if (!jev) return null
  // The handlers below are hoisted past the guard, so they need the narrowed value by name.
  const current = jev

  const drafted = draftRequest(jev.key, draft)
  const problems = drafted.ok ? [] : drafted.problems

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
          </section>

          <section aria-label="Response" className="flex min-w-0 flex-col gap-3">
            <AnswerList answers={null} stale={false} />
            <ResponsePanel run={null} origin={window.location.origin} />
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

function firstDraft(): SystemOneDraft {
  const { stateText, questionsText } = SYSTEMONE_EXAMPLES[0]
  return { stateText, questionsText }
}

const isStateProblem = (problem: DraftProblem): boolean => problem.field === 'state'

const isQuestionsProblem = (problem: DraftProblem): boolean => problem.field.startsWith('questions')

/** A fault in the request as a whole (its size, its model): neither editor owns it, so the screen does. */
const isRequestProblem = (problem: DraftProblem): boolean => !isStateProblem(problem) && !isQuestionsProblem(problem)
