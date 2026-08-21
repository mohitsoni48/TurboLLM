// Turbo Link (ADR-376 phase 3, task 6): the linked machines' engines, on the Engines
// screen, READ-ONLY.
//
// ADR-139 settled that no remote caller gets engine add/scan access — the surface executes
// a caller-supplied binary path, so it is not grantable to anything, valid key or not.
// `engines:*` is therefore absent from `LINK_CAPABILITIES` entirely (and `web-mirror.test.ts`
// guards that it stays absent, in any spelling).
//
// The interesting decision is how that absence is PRESENTED. Two wrong ways: leave remote
// machines off the screen (the user assumes Turbo Link is broken, or that their fleet only
// has one machine), or render the usual engine controls greyed out (a greyed control implies
// a permission that could be granted — the user goes to the host, hunts for an "engines"
// toggle that does not and can never exist, and files a bug). So: the machines ARE listed,
// there is NO control of any kind, and one plain sentence says why. That is the carve-out
// surfaced honestly rather than as a mysterious absence.
import { Cloud, Info } from 'lucide-react'
import { useRemoteEngines } from '../../lib/link-queries'
import type { LinkSummary, RemoteStatus } from '../../lib/link-api'
import { describeRemoteFailure } from '../../lib/remote-failure'
import { fleetMachines } from '../../lib/fleet'

export function RemoteEngines({ links }: { links: LinkSummary[] }) {
  const rows = useRemoteEngines(links)
  // Every link, online or not — an offline machine still gets a line, with its reason. This
  // is the same `fleetMachines` contract the merged lists use; passing empty row arrays is
  // exactly right, since a non-online machine contributes no engine either.
  const machines = fleetMachines(links.map((link) => ({ link, rows: [] as never[] })))

  // No links at all: the screen is exactly what it was before Turbo Link existed.
  if (links.length === 0) return null

  const byId = new Map(rows.map((r) => [r.link.id, r]))

  return (
    <div data-testid="remote-engines" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Cloud size={14} className="text-muted" />
        <span className="text-[13px] font-medium text-ink">Other machines</span>
      </div>

      {/* The carve-out, said plainly and once, above the rows it applies to. */}
      <div className="flex items-start gap-2 rounded-[var(--radius)] border border-border bg-panel px-3 py-2 text-[12px]">
        <Info size={13} className="mt-0.5 shrink-0 text-muted" />
        <span className="text-muted">
          Engines are managed on the machine that runs them. TurboLLM never installs, builds
          or switches an engine over a link — you can see what each machine is running here,
          and change it from that machine.
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-panel">
        {links.map((link) => {
          const row = byId.get(link.id)
          const machine = machines.find((m) => m.linkId === link.id)
          return (
            <RemoteEngineRow
              key={link.id}
              name={link.name}
              status={row?.status ?? null}
              // A machine that is not online has a note from `fleetMachines`; one that IS
              // online but whose status call was refused has a typed failure. Either way a
              // sentence, never a spinner that never resolves.
              note={
                machine?.note ??
                (row?.error ? describeRemoteFailure(row.error, link.name).message : null)
              }
              loading={row?.isLoading ?? false}
            />
          )
        })}
      </div>
    </div>
  )
}

/** One machine's engine, as text. Deliberately contains no button, link, menu, checkbox or
 *  switch — see the module comment. */
function RemoteEngineRow({
  name,
  status,
  note,
  loading,
}: {
  name: string
  status: RemoteStatus | null
  note: string | null
  loading: boolean
}) {
  const engine = status?.engine ?? null
  const model = status?.model ?? null
  const running = engine?.state === 'running'

  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {running && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--ok)' }} />
          )}
          <span className="truncate text-[14px] font-medium text-ink">{name}</span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted">
          {note ? (
            note
          ) : loading ? (
            // Only ever shown while a request is genuinely in flight. An unreachable machine
            // arrives as a typed failure above, not as a permanent "Checking…".
            'Checking…'
          ) : engine ? (
            <>
              {/* Engine NAME and state only. `port` and `pid` are on the wire shape but are
                  the host's internals — a fleet list has no use for them, and this feature
                  has already had several host-detail leaks. */}
              {engine.name}
              {' · '}
              {engine.state}
              {model ? ` · ${model.name}${model.quant ? ` (${model.quant})` : ''}` : ''}
            </>
          ) : (
            'No engine running'
          )}
        </div>
      </div>
    </div>
  )
}
