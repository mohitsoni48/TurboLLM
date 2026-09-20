// The way out of the playground (ADR-434 (c), (i)(5)).
//
// An inline list rather than a dropdown: it is the only navigation this screen has, and it
// answers the question the screen raises — "how do I get back to Chat?" — without a click to
// discover it. Nothing here navigates; loading a chat model clears `status.jev`, and the
// Workspace gate takes the user back on its own.
import { track } from '../../lib/api'
import type { useModelLoader } from '../../lib/model-loader'
import type { JevStatus, ModelEntry } from '../../lib/types'

type SwitchDeps = {
  stopEngine(key: string): Promise<unknown>
  requestLoad: ReturnType<typeof useModelLoader>['requestLoad']
}

export function SwitchModelMenu({
  current,
  models,
  onPick,
}: {
  current: JevStatus
  models: ModelEntry[]
  onPick: (m: ModelEntry) => void
}) {
  const loadable = models.filter((m) => canLoad(m, current))

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <ModelGroup title="Chat models" models={loadable.filter((m) => !m.jev)} onPick={onPick} />
      <ModelGroup title="Jev models" models={loadable.filter((m) => m.jev)} onPick={onPick} />
    </div>
  )
}

/** ADR-427: a Jev model in a POOL slot keeps its own engine, so a chat pick has to eject that
 *  slot — a primary swap already replaces what is running. */
export async function switchToModel(current: JevStatus, m: ModelEntry, deps: SwitchDeps): Promise<void> {
  track('workspace', 'jev_switch_model')
  if (!m.jev && current.slot === 'pool') await deps.stopEngine(current.key)
  deps.requestLoad({ key: m.key, name: m.name, isJev: !!m.jev })
}

function ModelGroup({ title, models, onPick }: { title: string; models: ModelEntry[]; onPick: (m: ModelEntry) => void }) {
  if (models.length === 0) return null
  return (
    <div className="flex flex-col gap-1" role="group" aria-label={title}>
      <span className="text-[12px] font-medium text-muted">{title}</span>
      {models.map((m) => (
        <button
          key={m.key}
          type="button"
          onClick={() => onPick(m)}
          className="rounded px-2 py-1 text-left text-[13px] text-ink hover:bg-panel-2"
        >
          {m.name}
        </button>
      ))}
    </div>
  )
}

/** Only models that would really load right now — an offer that 400s is worse than no offer. */
function canLoad(m: ModelEntry, current: JevStatus): boolean {
  return !m.incomplete && !m.parseError && m.compatibleWithActiveEngine && !m.embedding && m.key !== current.key
}
