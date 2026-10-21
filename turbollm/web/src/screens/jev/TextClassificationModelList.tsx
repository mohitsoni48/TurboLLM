// The library's text classification models, in the playground's own left column (ADR-444, amended 2026-09-25). It
// only shows and offers: what a Load or an Eject really does is the playground's switch and eject, the same path the
// Switch model menu takes.
import { Button } from '../../components/ui/button'
import { TextClassificationRuntimeLabel } from '../../components/TextClassificationRuntimeLabel'
import { NoModelsHint } from '../../components/NoModelsHint'
import { hiddenByUser, hiddenByUserCount, isSystemOneModel } from '../../lib/model-kind'
import type { LoadedJev, ModelEntry } from '../../lib/types'
import { canLoadNow } from './SwitchModelMenu'

const TITLE = 'Text classification models'

type ModelActions = {
  onLoad: (m: ModelEntry) => void
  onEject: (m: ModelEntry) => void
}

export function TextClassificationModelList({
  models,
  current,
  pendingKey,
  showAllEngineModels = false,
  ...actions
}: {
  models: ModelEntry[]
  current: LoadedJev | null
  pendingKey: string | undefined
  /** Settings → Models, "Show models for every engine": a row the selected engine cannot run offers its Load. */
  showAllEngineModels?: boolean
} & ModelActions) {
  // Not a model the user hid by hand (Models → Library "Hide"), unless it is the one loaded here.
  const classifiers = models.filter(isSystemOneModel)
  const listed = classifiers.filter((m) => !hiddenByUser(m) || isLoaded(m, current))
  return (
    <section aria-label={TITLE} className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2 py-3">
      <h2 className="px-2 text-[11px] font-medium uppercase tracking-wide text-faint">{TITLE}</h2>
      {listed.length === 0 && classifiers.length > 0 && (
        <div className="px-2">
          <div className="text-[13px] text-ink">No models found.</div>
          <NoModelsHint hidden={{ byEngine: 0, byUser: hiddenByUserCount(classifiers) }} offerDownload={false} />
        </div>
      )}
      {listed.map((m) => (
        <ModelRow
          key={m.key}
          model={m}
          loaded={isLoaded(m, current)}
          loading={m.key === pendingKey}
          showAllEngineModels={showAllEngineModels}
          {...actions}
        />
      ))}
    </section>
  )
}

/** The playground's model, or one the library reports loaded — a Laya model can run beside the Jev model the
 *  playground shows. */
function isLoaded(m: ModelEntry, current: LoadedJev | null): boolean {
  return m.loaded || m.key === current?.key
}

function ModelRow({
  model,
  loaded,
  loading,
  showAllEngineModels,
  onLoad,
  onEject,
}: { model: ModelEntry; loaded: boolean; loading: boolean; showAllEngineModels: boolean } & ModelActions) {
  const loadable = canLoadNow(model, showAllEngineModels)
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-ink">{model.name}</span>
        <TextClassificationRuntimeLabel model={model} />
        {/* Also beside a Load offered anyway (Settings' "Show models for every engine"): it says why it may fail. */}
        {!loaded && model.incompatibleReason && (
          <span className="text-[11px] text-faint">{model.incompatibleReason}</span>
        )}
      </div>
      {loaded ? (
        <Button variant="outline" size="sm" aria-label={`Eject ${model.name}`} onClick={() => onEject(model)}>
          Eject
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Load ${model.name}`}
          disabled={loading || !loadable}
          onClick={() => onLoad(model)}
        >
          {loading ? 'Loading…' : 'Load'}
        </Button>
      )}
    </div>
  )
}
