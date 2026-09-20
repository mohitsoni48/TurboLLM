// What is loaded, and the way out of it (ADR-434 (c), (i)(5)).
//
// The labels line is not decoration: a Jev model declares its own classes in config.json, so
// the three words below are the model's, not TurboLLM's, and the results view reads them in
// that same order.
import { ArrowLeftRight } from 'lucide-react'
import { Button } from '../../components/ui/button'
import type { JevStatus } from '../../lib/types'

const STATE_DOT: Record<JevStatus['state'], string> = {
  running: 'bg-ok',
  starting: 'bg-warn',
  stopping: 'bg-muted',
}

export function JevHeader({
  jev,
  engine,
  onSwitch,
}: {
  jev: JevStatus
  engine: { name: string; kind: string }
  onSwitch: () => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1 text-[13px] text-ink">
          <span className={`h-[7px] w-[7px] rounded-full ${STATE_DOT[jev.state]}`} />
          {`${jev.name} · ${engine.name} · ${stateLabel(jev.state)}`}
        </span>
        <Button variant="outline" size="sm" onClick={onSwitch}>
          <ArrowLeftRight size={14} /> Switch model
        </Button>
      </div>
      <p className="text-[12px] text-muted">Labels read from the model: {jev.labels.join(', ')}</p>
    </div>
  )
}

/** "starting" is engine-speak; a user watching a model come up reads "Loading…". */
function stateLabel(state: JevStatus['state']): string {
  return state === 'starting' ? 'Loading…' : state
}
