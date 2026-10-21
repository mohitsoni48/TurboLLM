import type { PickerHidden } from '../lib/model-kind'
import { cn } from '../lib/utils'

/** The line under a model picker's "No models found.": how many models it leaves out and the switch that lists them,
 *  or, with none left out, where to get one. A picker with nothing to offer used to show only its heading over an
 *  empty list, so a library of models the selected engine cannot run looked like no library at all. Plain text, not
 *  links: Settings has no address for its Models & loading pane, and ModelLoadMenu also renders outside a router. */
export function NoModelsHint({
  hidden,
  offerDownload = true,
  className,
}: {
  hidden?: PickerHidden
  /** Off where something else is on offer (ModelLoadMenu's linked machines): "download one" would be noise there. */
  offerDownload?: boolean
  className?: string
}) {
  const byEngine = hidden?.byEngine ?? 0
  if (byEngine === 0 && !offerDownload) return null
  return (
    <div className={cn('text-[12px] text-muted', className)}>
      {byEngine > 0
        ? `${byEngine} hidden: the selected engine can't run ${byEngine === 1 ? 'it' : 'them'} — Settings → Models & loading → Show models for every engine.`
        : 'Download one in Models → Discover.'}
    </div>
  )
}
