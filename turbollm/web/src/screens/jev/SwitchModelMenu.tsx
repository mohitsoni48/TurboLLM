// The way out of the playground (ADR-434 (c), (i)(5)).
//
// An inline list rather than a dropdown: it is the only navigation this screen has, and it
// answers the question the screen raises — "how do I get back to Chat?" — without a click to
// discover it. Nothing here navigates: the playground takes the user back to Chat once a chat
// model picked here has replaced its own.
import { ApiError, track } from '../../lib/api'
import type { LoadOptions, LoadTarget } from '../../lib/model-loader'
import { isSystemOneModel, loadOffered } from '../../lib/model-kind'
import { TextClassificationRuntimeLabel } from '../../components/TextClassificationRuntimeLabel'
import { toast } from '../../components/ui/sonner'
import type { LoadedJev, ModelEntry } from '../../lib/types'

// Nothing here suggests another engine: a model loads only on the one the user selected. The setting lists the rest.
const NOTHING_LOADABLE =
  'Nothing else here can load on the selected engine. Settings → Models & loading → "Show models for every engine" lists every model.'
const NOTHING_LOADABLE_SHOWING_ALL = 'Nothing else here can be loaded.'

type SwitchDeps = {
  stopEngine(key: string): Promise<unknown>
  requestLoad(target: LoadTarget, opts?: LoadOptions): void
}

export function SwitchModelMenu({
  current,
  models,
  onPick,
  showAllEngineModels = false,
}: {
  current: LoadedJev
  models: ModelEntry[]
  onPick: (m: ModelEntry) => void
  /** Settings → Models, "Show models for every engine" (useShowAllEngineModels). */
  showAllEngineModels?: boolean
}) {
  const loadable = models.filter((m) => canLoad(m, current, showAllEngineModels))

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      {loadable.length === 0 ? (
        <p className="text-[13px] text-muted">{showAllEngineModels ? NOTHING_LOADABLE_SHOWING_ALL : NOTHING_LOADABLE}</p>
      ) : (
        <>
          <ModelGroup title="Chat models" models={loadable.filter((m) => !isSystemOneModel(m))} onPick={onPick} />
          <ModelGroup title="Text classification models" models={loadable.filter((m) => isSystemOneModel(m))} onPick={onPick} />
        </>
      )}
    </div>
  )
}

/** ADR-427: a Jev model in a POOL slot keeps its own engine, so a chat pick has to eject that
 *  slot — a primary swap already replaces what is running. A slot that refuses to eject stops
 *  the switch and says so: loading on top of it would leave the playground open with no
 *  explanation. With nothing loaded (ADR-444, amended 2026-09-25) there is nothing to eject. */
export async function switchToModel(current: LoadedJev | null, m: ModelEntry, deps: SwitchDeps): Promise<void> {
  track('workspace', 'jev_switch_model')
  if (current && needsEject(current, m) && !(await ejected(current, deps))) return
  deps.requestLoad(m)
}

/** The playground's model list ejects a model in place. A refusal says so, or the row would look as if the click
 *  did nothing. */
export async function ejectModel(m: ModelEntry, deps: Pick<SwitchDeps, 'stopEngine'>): Promise<void> {
  track('workspace', 'eject_model')
  await stoppedOrReported(m.key, deps, (e) => `Could not eject model: ${failureReason(e)}`)
}

/** Only a primary slot is replaced by the load itself. An unknown slot (the catalog fallback
 *  cannot read one) is ejected too: leaving a pool slot held keeps Workspace in the playground
 *  with nothing said, while an unnecessary stop only costs the engine a restart. */
function needsEject(current: LoadedJev, m: ModelEntry): boolean {
  // A Laya load never replaces the primary and runs beside chat models (ADR-443), and a loaded Laya model keeps the
  // playground open. So switching model in the playground has to eject what the playground is showing, and any Laya
  // pick has to eject a Jev model, wherever it sits.
  if (current.checkpoints) return true
  if (m.laya) return true
  return !m.jev && current.slot !== 'primary'
}

function ejected(current: LoadedJev, deps: SwitchDeps): Promise<boolean> {
  return stoppedOrReported(current.key, deps, (e) => `Could not switch model: ${failureReason(e)}`)
}

async function stoppedOrReported(
  key: string,
  deps: Pick<SwitchDeps, 'stopEngine'>,
  failureMessage: (e: unknown) => string,
): Promise<boolean> {
  try {
    await deps.stopEngine(key)
    return true
  } catch (e) {
    toast.error(failureMessage(e))
    return false
  }
}

function failureReason(e: unknown): string {
  return e instanceof ApiError ? e.message : 'check the engine logs on the Engines screen.'
}

function ModelGroup({ title, models, onPick }: { title: string; models: ModelEntry[]; onPick: (m: ModelEntry) => void }) {
  if (models.length === 0) return null
  return (
    <div className="flex flex-col gap-1" role="group" aria-label={title}>
      <span className="text-[12px] font-medium text-muted">{title}</span>
      {models.map((m) => (
        // The runtime label sits outside the button, so the button is still named for the model alone.
        <div key={m.key} className="flex items-center gap-2 pr-2">
          <button
            type="button"
            onClick={() => onPick(m)}
            className="flex-1 rounded px-2 py-1 text-left text-[13px] text-ink hover:bg-panel-2"
          >
            {m.name}
          </button>
          <TextClassificationRuntimeLabel model={m} />
        </div>
      ))}
    </div>
  )
}

function canLoad(m: ModelEntry, current: LoadedJev, showAllEngineModels: boolean): boolean {
  return canLoadNow(m, showAllEngineModels) && m.key !== current.key
}

/** Only models that would really load right now — an offer that 400s is worse than no offer. With Settings' "Show
 *  models for every engine" on, also one the selected engine is not expected to run: like every model picker's, its
 *  load starts on the selected engine and shows that engine's error if it fails (lib/model-kind.ts loadOffered). */
export function canLoadNow(m: ModelEntry, showAllEngineModels = false): boolean {
  return !m.incomplete && !m.parseError && loadOffered(m, showAllEngineModels) && !m.embedding
}
