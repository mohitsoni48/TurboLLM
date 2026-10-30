import type { AnchorHTMLAttributes, Ref } from 'react'
import { Link } from 'react-router-dom'
import type { PickerHidden } from '../lib/model-kind'
import { cn } from '../lib/utils'

/** Where the Library lists the models the user hid, with an Unhide on each (ModelsScreen reads `hidden=1`). */
export const SHOW_HIDDEN_MODELS_PATH = '/models?hidden=1'

/** What a picker adds to the "Show hidden models" link to make it one of its own targets (ModelLoadMenu). */
export type HintLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  ref?: Ref<HTMLAnchorElement>
  'data-active'?: ''
}

/** The lines under a model picker's "No models found.": how many models it leaves out and the switch that lists them,
 *  or, with none left out, where to get one. A picker with nothing to offer used to show only its heading over an
 *  empty list, so a library of models the selected engine cannot run looked like no library at all. The engine's line
 *  is plain text: Settings has no address for its Models & loading pane. The user's own hidden models link to the
 *  Library's "Show hidden models"; that line only renders when some are hidden, which a picker only knows inside the
 *  app's router. */
export function NoModelsHint({
  hidden,
  offerDownload = true,
  className,
  linkProps,
}: {
  hidden?: PickerHidden
  /** Off where something else is on offer (ModelLoadMenu's linked machines): "download one" would be noise there. */
  offerDownload?: boolean
  className?: string
  /** Inside a picker whose keyboard never leaves its search box: the id, highlight and handlers that let ArrowDown
   *  reach the link and Enter follow it. Elsewhere the link sits in the page and Tab reaches it. */
  linkProps?: HintLinkProps
}) {
  const byEngine = hidden?.byEngine ?? 0
  const byUser = hidden?.byUser ?? 0
  const download = offerDownload && byEngine === 0 && byUser === 0
  if (byEngine === 0 && byUser === 0 && !download) return null
  return (
    <div className={cn('flex flex-col gap-0.5 text-[12px] text-muted', className)}>
      {byUser > 0 && (
        <span>
          {byUser} hidden by you —{' '}
          <Link
            {...linkProps}
            to={SHOW_HIDDEN_MODELS_PATH}
            className="rounded-sm font-medium text-accent hover:underline data-[active]:bg-panel-2 data-[active]:underline"
          >
            Show hidden models
          </Link>
        </span>
      )}
      {byEngine > 0 && (
        <span>
          {`${byEngine} hidden: the selected engine can't run ${byEngine === 1 ? 'it' : 'them'} — Settings → Models & loading → Show models for every engine.`}
        </span>
      )}
      {download && <span>Download one in Models → Discover.</span>}
    </div>
  )
}
