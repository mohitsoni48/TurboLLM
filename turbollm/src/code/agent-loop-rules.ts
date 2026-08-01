// Pure agent-behaviour primitives: consecutive-identical-tool-call loop detection and
// dependency-add command matching.
//
// Extracted verbatim out of code-session.ts so BOTH coding agents can enforce the same rules.
// The originals were reachable only from inside the pi-SDK session module, which is why the
// terminal-agent path (Claude Code and any other CLI driving the Anthropic gateway) silently had
// none of them: importing them from `gateway/` would have dragged the entire pi SDK into the
// gateway's import graph. Nothing here touches pi, a model, or the filesystem — it is all string
// and counter logic, which is also what makes it testable on its own.
//
// code-session.ts re-exports every symbol below, so its existing importers and tests are
// unchanged; the gateway imports from here directly.

// ── Consecutive identical tool-call loop breaker (founder-reported) ────────────
// A weak local model can get stuck firing the SAME tool with the SAME arguments over and over,
// making no progress — the turn never settles and reads to the user as a hung agent. After
// LOOP_BREAK_AFTER consecutive identical calls the in-process (pi) agent stops EXECUTING the tool
// and hands the model a direct break-the-loop instruction instead. A different tool, different
// arguments, or a new top-level turn resets the count. The first LOOP_BREAK_AFTER identical calls
// still run normally, so a model that legitimately repeats a call a few times is unaffected —
// only a genuine loop is cut.
export const LOOP_BREAK_AFTER = 3

// The soft nudge above assumes the model actually reads and acts on the blocked-call result — a
// genuinely stuck weak/local model can just re-emit the exact same call again anyway, and
// ToolLoopTracker.record() has no ceiling (a re-tripped signature keeps incrementing forever, see
// its own test), so nothing was stopping this from repeating indefinitely — reproduced live
// (founder-reported, 2026-07-24: the nudge fired and had "no effect", the run stayed stuck).
// LOOP_ABORT_AFTER is the hard ceiling: after this many consecutive identical calls (i.e. the
// model ignored LOOP_ABORT_AFTER - LOOP_BREAK_AFTER separate nudges), stop assuming it'll
// self-heal and stop the run outright rather than letting it spin.
export const LOOP_ABORT_AFTER = LOOP_BREAK_AFTER + 3

/** Order-stable signature of a tool call: the name plus its arguments with object keys sorted at
 *  every depth, so a model re-emitting the same call with its keys in a different order still
 *  compares equal. Pure. */
export function toolCallSignature(name: string, input: unknown): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return `${name}\u0000${stable(input)}`
}

/** Tracks consecutive identical tool calls within a turn. `record()` returns the running count
 *  for the current (tool, args) signature — 1 for a fresh call, N for the Nth identical one in a
 *  row; any different call resets it to 1. The caller breaks the loop once the count exceeds
 *  {@link LOOP_BREAK_AFTER}. Deliberately isolable so it's unit-testable without pi or a model. */
export class ToolLoopTracker {
  private lastSig: string | null = null
  private count = 0
  record(name: string, input: unknown): number {
    const sig = toolCallSignature(name, input)
    if (sig === this.lastSig) this.count += 1
    else { this.lastSig = sig; this.count = 1 }
    return this.count
  }
  reset(): void { this.lastSig = null; this.count = 0 }
}

// Mechanical half of the dependency-discipline fix (founder-reported gap, 2026-07-13, item 2,
// see persona.ts's dependencyDisciplineGuidance for the full rationale): matches shell commands
// that add a NEW dependency across common package managers, deliberately requiring an argument
// after the add/install verb so a bare `npm install`/`pip install -r requirements.txt` (installing
// from an existing manifest, not deciding on a new dependency) doesn't false-positive. This only
// covers CLI installs — a precise, well-defined signal. Manifest edits made by hand (e.g. Gradle's
// `dependencies {}` block) have no equally precise signal without false-positiving on unrelated
// edits to the same file, so those aren't checked here and rely on the prompt guidance alone.
const DEPENDENCY_ADD_PATTERNS = [
  /\bnpm\s+(i|install|add)\s+\S/,
  /\byarn\s+add\s+\S/,
  /\bpnpm\s+add\s+\S/,
  /\bpip3?\s+install\s+(?!-r\b)(?!-e\s+\.)\S/,
  /\bpoetry\s+add\s+\S/,
  /\bcargo\s+add\s+\S/,
  /\bgo\s+get\s+\S/,
  /\bgem\s+install\s+\S/,
  /\bbundle\s+add\s+\S/,
  /\bcomposer\s+require\s+\S/,
]
export function isDependencyAddCommand(command: string): boolean {
  return DEPENDENCY_ADD_PATTERNS.some((re) => re.test(command))
}
