import { useState } from 'react'
import { ChevronRight, FileText, Plus, X } from 'lucide-react'
import { useSettings } from '../../lib/queries'
import { ApiError, track } from '../../lib/api'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { toast } from '../../components/ui/sonner'
import { cn } from '../../lib/utils'

/** One editable ORDERED candidate-filename list, mirroring BuildGuideDialog's toolchain-dirs
 *  list editor (draft-until-saved, one input row per entry). `candidates` is the saved value;
 *  `draft` (null when not being edited) shadows it locally so typing doesn't fire a save per
 *  keystroke. First candidate that actually exists on disk wins at read time (persona.ts's
 *  resolveAgentsFile) — order matters, which is why this is a list of rows, not an unordered
 *  chip set. */
function CandidateList({ label, hint, placeholder, candidates, saving, onSave }: {
  label: string
  hint: string
  placeholder: string
  candidates: string[]
  saving: boolean
  onSave: (next: string[]) => void
}) {
  const [draft, setDraft] = useState<string[] | null>(null)
  const rows = draft ?? candidates
  const cleaned = rows.map((r) => r.trim()).filter(Boolean)
  const dirty = draft !== null && JSON.stringify(cleaned) !== JSON.stringify(candidates)

  const save = () => {
    track('settings', 'save_context_candidates')
    onSave(cleaned)
    setDraft(null)
  }

  return (
    <div>
      <div className="text-[13px] font-medium text-ink">{label}</div>
      <p className="mb-2 mt-0.5 text-[11px] text-faint">{hint}</p>
      <div className="flex flex-col gap-1.5">
        {rows.map((entry, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-4 shrink-0 text-right font-mono text-[11px] text-faint">{i + 1}</span>
            <input
              value={entry}
              onChange={(e) => {
                const next = [...rows]
                next[i] = e.target.value
                setDraft(next)
              }}
              placeholder={placeholder}
              className="min-w-0 flex-1 rounded-md border border-border bg-panel-2 px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => { track('settings', 'remove_context_candidate'); setDraft(rows.filter((_, j) => j !== i)) }}
              className="shrink-0 rounded-md p-1 text-faint hover:text-ink"
              aria-label={`Remove candidate ${i + 1}`}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => { track('settings', 'add_context_candidate'); setDraft([...rows, '']) }}
            className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
          >
            <Plus size={13} /> Add candidate
          </button>
          {dirty && (
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Which file(s) Code reads as standing project/user instructions (persona.ts's AGENTS.md-style
 *  injection, like OpenCode's AGENTS.md convention) — configurable instead of the old hardcoded
 *  exactly-AGENTS.md/exactly-agents.md. Each list below is tried IN ORDER; the FIRST existing,
 *  readable file wins — not a merge of every match (a repo with "CLAUDE.md instead of AGENTS.md"
 *  should get just CLAUDE.md's content, not both concatenated). Global-only for now: one shared
 *  pair of lists applies to every repo/session alike, not a per-project override — the built-in
 *  defaults already solve the common case (a repo using CLAUDE.md as its convention) with zero
 *  configuration, since CLAUDE.md is already a candidate on both sides. */
export function CodeContextSection() {
  const [open, setOpen] = useState(false)
  const { query: settingsQ, save } = useSettings()
  // Optional-chained one level deeper than the type strictly requires: a daemon still running an
  // older build (e.g. this exact dev-server-against-a-stale-production-daemon setup) won't have
  // `code` in its /api/v1/settings response yet, and this section should degrade to empty lists
  // rather than crash the whole Settings screen.
  const project = settingsQ.data?.code?.agentsMdProjectCandidates ?? []
  const global = settingsQ.data?.code?.agentsMdGlobalCandidates ?? []

  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not update standing-context files.')

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-panel p-4">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <ChevronRight size={14} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        <FileText size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Standing context (Code)</h2>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mb-4 mt-3 text-[12px] text-muted">
          Code automatically reads one standing-instructions file per project (from the repo root) and one
          global file (from TurboLLM&apos;s own data dir) into every session, the same way OpenCode&apos;s
          AGENTS.md convention works. Each list below is tried in order — the first file that actually
          exists wins.
        </p>
        <div className="flex flex-col gap-5">
          <CandidateList
            label="Project file (repo root)"
            hint="Tried against the root of whichever repo a Code session is running in."
            placeholder="AGENTS.md"
            candidates={project}
            saving={save.isPending}
            onSave={(next) => save.mutate({ code: { agentsMdProjectCandidates: next } }, { onError })}
          />
          <CandidateList
            label="Global file"
            hint="Tried against TurboLLM's own data directory (~/.turbollm) — applies to every session."
            placeholder="agents.md"
            candidates={global}
            saving={save.isPending}
            onSave={(next) => save.mutate({ code: { agentsMdGlobalCandidates: next } }, { onError })}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
