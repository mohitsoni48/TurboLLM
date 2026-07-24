import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Sparkles } from 'lucide-react'

export interface CodeResourcesHeaderProps {
  /** How many skills are available to the session — the shared SkillStore catalog (every one is
   *  reachable via invoke_skill; Code has no per-session enabled subset, unlike Chat). */
  skillCount: number
  /** Whether a project (`<repoRoot>/AGENTS.md`) and/or global (`~/.turbollm/agents.md`) AGENTS.md
   *  is loaded for this session — from the session-detail response (code-api.ts). */
  hasAgentsMd: { project: boolean; global: boolean }
}

/**
 * Collapsible loaded-resources header (ADR-262) — surfaces what pi's own
 * `[Context]/[Skills]/[Prompts]` startup dump shows: the standing context (AGENTS.md) and the skill
 * library actually loaded for this session, which persona.ts already assembles server-side but the
 * UI never showed anywhere.
 *
 * Deliberately shows ONLY these two resources — NOT mode, model, or context stats. Those already
 * have a single on-screen home (the composer's editable mode picker and the stats footer), and
 * ADR-262's hard constraint is that no stat/state renders in more than one place; AGENTS.md and the
 * skill count are the two things that had no on-screen home at all, so they're the whole job here.
 * Collapsed to one line by default, matching pi's compact "one-line, expand for detail" convention.
 */
export function CodeResourcesHeader({ skillCount, hasAgentsMd }: CodeResourcesHeaderProps) {
  const [expanded, setExpanded] = useState(false)
  const agentsLoaded = hasAgentsMd.project || hasAgentsMd.global
  const skillsLabel = `${skillCount} skill${skillCount === 1 ? '' : 's'}`

  return (
    <div className="shrink-0 border-b border-border text-[11px] text-muted">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label="Loaded resources"
        className="flex w-full items-center gap-2 px-4 py-1.5 transition-colors hover:text-ink md:px-8"
      >
        {expanded
          ? <ChevronDown size={12} className="shrink-0 text-faint" />
          : <ChevronRight size={12} className="shrink-0 text-faint" />}
        <span className="inline-flex items-center gap-1">
          <FileText size={11} className="shrink-0 text-faint" />
          {agentsLoaded ? 'AGENTS.md' : 'No AGENTS.md'}
        </span>
        <span aria-hidden className="text-faint">·</span>
        <span className="inline-flex items-center gap-1">
          <Sparkles size={11} className="shrink-0 text-faint" />
          {skillsLabel}
        </span>
      </button>

      {expanded && (
        <dl className="flex flex-col gap-1 px-4 pb-2 pl-9 md:px-8 md:pl-[3.25rem]">
          <div className="flex items-center gap-2">
            <dt className="w-16 shrink-0 text-faint">Project</dt>
            <dd>{hasAgentsMd.project ? 'AGENTS.md loaded' : 'not found'}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="w-16 shrink-0 text-faint">Global</dt>
            <dd>{hasAgentsMd.global ? 'agents.md loaded' : 'not found'}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="w-16 shrink-0 text-faint">Skills</dt>
            <dd>{skillCount === 0 ? 'none available' : `${skillsLabel} reachable via invoke_skill`}</dd>
          </div>
        </dl>
      )}
    </div>
  )
}
