// Agent behaviour scaffolding for EXTERNAL coding CLIs driving the Anthropic gateway.
//
// ── Why this exists (founder-reported) ──────────────────────────────────────────────────────
// TurboLLM has two coding agents. The in-app one runs pi in-process (code/code-session.ts), so
// TurboLLM owns its system prompt AND sits in its tool-execution path — which is where all five
// of the behaviours the founder built actually live:
//
//   1. loop detection                       ToolLoopTracker            (code-session.ts)
//   2. tool-call loop breaking              LOOP_BREAK_AFTER / _ABORT  (code-session.ts)
//   3. search the web when something fails  consecutiveToolFailures    (code-session.ts)
//   4. research the approach first          antiFallbackGuidance()     (persona.ts)
//   5. always check versions + docs first   isDependencyAddCommand,
//                                           dependencyDisciplineGuidance()
//
// The second agent is a real `claude` CLI in a PTY (terminal/), which touches TurboLLM ONLY over
// HTTP at /v1/messages. Every one of the five lived on the far side of that boundary, so the CLI
// had none of them: `buildTerminalLaunchCommand` passes `--port/--token/--session-id/
// --permission-mode` and nothing else, and `cli-launch.ts` sets only ANTHROPIC_* env vars.
//
// The gateway is the one place both agents pass through, so the scaffolding is rebuilt here from
// the request itself. That also means it applies to any other Anthropic-protocol client, not just
// `claude`.
//
// ── Why the detectors are stateless ─────────────────────────────────────────────────────────
// code-session.ts can hold counters because it owns a long-lived session object. The gateway is a
// plain HTTP handler with no per-session memory — but it does not need any: an Anthropic request
// carries the ENTIRE conversation every turn, so "the last N tool calls were identical" and "the
// last N tool results were errors" are both directly readable off `req.messages`. No state, no
// eviction, and it survives a daemon restart mid-session for free.
//
// ── What this can and cannot enforce ────────────────────────────────────────────────────────
// pi's loop breaker refuses to EXECUTE the repeated call. The gateway is not in an external CLI's
// tool-execution path — the CLI runs its own tools locally — so the equivalent lever here is
// `tool_choice`. The escalation deliberately mirrors pi's two stages rather than inventing a
// third: a nudge first (tools still available, so the model can try a DIFFERENT approach, which
// is what pi's per-call block leaves it free to do), then a hard `tool_choice: 'none'` at the
// ceiling, which makes repeating the call mechanically impossible and ends the turn in text — the
// gateway's counterpart to pi's session.abort().
import { LOOP_ABORT_AFTER, LOOP_BREAK_AFTER, isDependencyAddCommand, toolCallSignature } from '../code/agent-loop-rules'
import type { AnthropicRequest } from './anthropic'

/** How far back to look for a web search when deciding whether a dependency was added blind.
 *  Counted in tool calls, not messages: an agent can fire several tools per assistant turn, and a
 *  message-based window would scale with how chatty the client is rather than with how much work
 *  happened since the search. */
const DEPENDENCY_SEARCH_LOOKBACK = 8

/** Tool names that mean "searched the web", across the CLIs that reach this gateway: Claude Code
 *  (`WebSearch`), TurboLLM's own in-app agent and most OpenAI-style clients (`web_search`), and
 *  the server-tool spelling. Compared case-insensitively after stripping non-letters, so
 *  `web_search`, `WebSearch` and `websearch` all collapse to one entry. */
const SEARCH_TOOL_NAMES = new Set(['websearch', 'search', 'webfetch', 'fetchurl'])

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '')
}

/** A tool call recovered from the request history, oldest → newest. */
interface HistoricCall {
  name: string
  input: unknown
}

/** Every `tool_use` block in the conversation, in order. */
export function toolCallHistory(messages: AnthropicRequest['messages']): HistoricCall[] {
  const out: HistoricCall[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    for (const b of msg.content) {
      if (b.type === 'tool_use') out.push({ name: b.name, input: b.input })
    }
  }
  return out
}

/** How many times the MOST RECENT tool call has been repeated identically, back-to-back. 1 means
 *  "called once, no repetition". Mirrors ToolLoopTracker.record()'s return value, which is what
 *  makes the LOOP_BREAK_AFTER / LOOP_ABORT_AFTER thresholds directly comparable between the two
 *  agents instead of two similar-looking numbers that mean subtly different things. */
export function trailingIdenticalCalls(messages: AnthropicRequest['messages']): { name: string; count: number } | null {
  const calls = toolCallHistory(messages)
  if (calls.length === 0) return null
  const last = calls[calls.length - 1]
  const sig = toolCallSignature(last.name, last.input)
  let count = 0
  for (let i = calls.length - 1; i >= 0; i--) {
    if (toolCallSignature(calls[i].name, calls[i].input) !== sig) break
    count++
  }
  return { name: last.name, count }
}

/** How many tool results in a row, ending at the newest, came back as errors.
 *
 *  `is_error` is the Anthropic-protocol flag a client sets on a failed `tool_result`; it is not in
 *  this file's own ABlock union (the gateway never needed to read it before), so it is read
 *  defensively off the raw block rather than by narrowing a type that does not describe it. */
export function trailingToolFailures(messages: AnthropicRequest['messages']): number {
  // Flatten every tool_result in order first: a single user message can carry several (one per
  // parallel tool call), and a run of failures can span message boundaries.
  const results: boolean[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue
    for (const b of msg.content) {
      if (b.type !== 'tool_result') continue
      results.push((b as unknown as { is_error?: boolean }).is_error === true)
    }
  }
  let count = 0
  for (let i = results.length - 1; i >= 0 && results[i]; i--) count++
  return count
}

/** Extract a shell command string from a tool call, or null when it isn't one. Covers the arg name
 *  every CLI in play uses — Claude Code's Bash tool takes `command`, pi's bash tool takes `cmd`. */
function shellCommandOf(call: HistoricCall): string | null {
  const input = call.input as Record<string, unknown> | null | undefined
  if (!input || typeof input !== 'object') return null
  for (const key of ['command', 'cmd', 'script']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/** The most recent dependency-installing shell command that ran WITHOUT a web search anywhere in
 *  the preceding {@link DEPENDENCY_SEARCH_LOOKBACK} tool calls, or null. This is the mechanical
 *  half of rule 5 — the same signal `code-session.ts` uses, evaluated against request history
 *  instead of live session counters. */
export function blindDependencyAdd(messages: AnthropicRequest['messages']): string | null {
  const calls = toolCallHistory(messages)
  for (let i = calls.length - 1; i >= 0; i--) {
    const command = shellCommandOf(calls[i])
    if (!command || !isDependencyAddCommand(command)) continue
    const from = Math.max(0, i - DEPENDENCY_SEARCH_LOOKBACK)
    const searched = calls
      .slice(from, i)
      .some((c) => SEARCH_TOOL_NAMES.has(normalizeToolName(c.name)))
    return searched ? null : command
    // Only the MOST RECENT install is judged: an earlier one was either already nudged on its own
    // turn or is old enough that re-raising it now would be noise competing with current work.
  }
  return null
}

/** What the client calls its web-search / web-fetch tools, so the guidance names tools that
 *  actually exist for THIS client. Claude Code declares `WebSearch`/`WebFetch`; TurboLLM's own
 *  agent and most OpenAI-style clients use `web_search`/`fetch_url`. Returns null for each tool
 *  the client didn't declare — guidance that tells a model to call a tool it does not have is
 *  worse than saying nothing (the same rule persona.ts's `hasWebTools` gate already follows). */
export function webToolNames(tools: AnthropicRequest['tools']): { search: string | null; fetch: string | null } {
  let search: string | null = null
  let fetch: string | null = null
  for (const t of tools ?? []) {
    const n = normalizeToolName(t.name ?? '')
    if (!search && (n === 'websearch' || n === 'search')) search = t.name
    if (!fetch && (n === 'webfetch' || n === 'fetchurl')) fetch = t.name
  }
  return { search, fetch }
}

/** The standing behavioural rules, adapted to this client's tool names. Text is deliberately kept
 *  in lockstep with `persona.ts`'s antiFallbackGuidance/dependencyDisciplineGuidance so both
 *  agents are held to the SAME rules — if one is reworded, reword the other. Returns [] when the
 *  client declared no web tools, in which case rules 4 and 5 have nothing to call.
 *
 *  `today` defaults to the SYSTEM date, read fresh on every call — a default parameter is
 *  re-evaluated per invocation, so a daemon left running for weeks never serves a date captured at
 *  module load (the exact staleness builtin.ts's `webSearchTool` comment warns about). UTC, matching
 *  builtin.ts's `todayIso()`: every other date in play — provider `published_date`, the `Retrieved:`
 *  stamp — is already UTC, and mixing in a local date would make those comparisons inconsistent.
 *  The parameter exists so tests can pin a value; nothing in production passes it. */
export function standingGuidance(
  tools: AnthropicRequest['tools'],
  today = new Date().toISOString().slice(0, 10),
): string[] {
  const { search, fetch } = webToolNames(tools)
  if (!search) return []
  // Phrased as a verb applied to a caller-supplied object so each rule can name what it wants read
  // (a search result, or a specific version's docs) without string-surgery on a shared sentence.
  const read = (what: string) => (fetch ? `use ${fetch} to read ${what}` : `read ${what}`)

  return [
    // Observed live the first time rule 5 fired end-to-end: told to verify a package it had just
    // installed, the model searched `zod npm latest version 2024` — it dated the query from
    // training data and would have "confirmed" a version two years stale. builtin.ts already
    // solves this for the in-app agent by stamping the date into the web_search tool's own
    // DESCRIPTION, which is exactly where a model composes a query from; that lever doesn't exist
    // here, because the tool schema belongs to the CLI, not to us. Stating the date as its own
    // standing rule is the closest equivalent the gateway has.
    `TODAY IS ${today}. Never put a year you remember into a search query — if a query needs a ` +
      `year, it is ${today.slice(0, 4)}. Treat your own training data as potentially years out of date.`,

    // Rule 4 — research the approach first / don't silently substitute an easier feature.
    `When you fail at a task twice in a row (a build error, a failing test, an API that doesn't ` +
      `behave as expected), do NOT quietly substitute an easier or different feature than what was ` +
      `actually requested — that is a critical failure even if the substitute "works". Instead, call ` +
      `${search} for the official documentation (and Stack Overflow or similar as a secondary source, ` +
      `weighting official docs higher) on the exact error or API you are stuck on, ` +
      `${read('the most relevant result')}, and retry the ORIGINAL task with what you learned.`,

    // Rule 5 — versions and docs before any new dependency.
    `STRICT RULE, no exceptions: before adding ANY new dependency — a library, package, or SDK, on ` +
      `ANY platform (npm/yarn/pnpm, pip/poetry, Gradle/Android, cargo, go modules, gems, composer, ` +
      `anything) — you MUST first call ${search} to find its current LATEST version (never assume a ` +
      `version from memory, it may be outdated), then ${read("that version's real official documentation")}. ` +
      `Only after doing both should you write the dependency declaration or install command, and ` +
      `implement against what you actually just read rather than remembered training knowledge, ` +
      `which is frequently stale for fast-moving libraries.`,
  ]
}

/** The result of inspecting one request. */
export interface TurnGuidance {
  /** Standing rules to append to the system prompt. Stable for the whole session, so appending
   *  them does not disturb the engine's reusable prompt prefix after the first turn. */
  system: string[]
  /** Situational nudges to append at the very END of the conversation, where the model is most
   *  likely to act on them and where they cost no prefix reuse. */
  nudges: string[]
  /** True once a loop has survived {@link LOOP_ABORT_AFTER} identical calls: the outbound request
   *  is forced to `tool_choice: 'none'` so the model physically cannot repeat the call again. */
  forceTextOnly: boolean
}

/** Inspect a request and decide what scaffolding it needs. Pure — no I/O, no state. */
export function analyzeTurn(req: AnthropicRequest): TurnGuidance {
  const nudges: string[] = []
  let forceTextOnly = false

  // Rules 1 + 2 — loop detection and breaking.
  const loop = trailingIdenticalCalls(req.messages)
  if (loop && loop.count >= LOOP_ABORT_AFTER) {
    forceTextOnly = true
    nudges.push(
      `[SYSTEM: \`${loop.name}\` has now been called with identical arguments ${loop.count} times in a row ` +
        `and is clearly not making progress. Tool calls are DISABLED for this reply. Stop, and answer in ` +
        `plain text: say what you were trying to do, what is actually blocking you, and what you need ` +
        `from the user to continue. Do not claim the task is done.]`,
    )
  } else if (loop && loop.count >= LOOP_BREAK_AFTER) {
    nudges.push(
      `[SYSTEM: you have called \`${loop.name}\` with identical arguments ${loop.count} times in a row and ` +
        `it is not making progress. Do NOT call it again with the same arguments — that will keep failing. ` +
        `Either change the arguments, use a different tool or approach, or stop and tell the user what is ` +
        `blocking you.]`,
    )
  }

  // Rule 3 — search the web when things keep failing. Threshold of 2 matches code-session.ts's
  // consecutiveToolFailures gate exactly.
  const failures = trailingToolFailures(req.messages)
  if (failures >= 2) {
    const { search } = webToolNames(req.tools)
    nudges.push(
      `[SYSTEM: failed attempt #${failures} in a row on this task. Stop retrying variations of the same ` +
        `thing from memory. ` +
        (search
          ? `Call \`${search}\` for the exact error message or API you are stuck on, read the official ` +
            `documentation, and retry the ORIGINAL task with what you learned. `
          : '') +
        `Do NOT substitute an easier or different feature than the one that was actually requested.]`,
    )
  }

  // Rule 5's mechanical half — a dependency went in without anyone checking its current version.
  const blindAdd = blindDependencyAdd(req.messages)
  if (blindAdd) {
    const { search } = webToolNames(req.tools)
    if (search) {
      nudges.push(
        `[SYSTEM: \`${blindAdd.trim().slice(0, 200)}\` added a dependency without first checking its current ` +
          `version and documentation. Call \`${search}\` now for that package's LATEST version and its real ` +
          `official docs, then correct the version you just pinned if it is wrong and implement against what ` +
          `you actually read — not remembered training knowledge, which is frequently stale.]`,
      )
    }
  }

  return { system: standingGuidance(req.tools), nudges, forceTextOnly }
}

/** Apply guidance to a request IN PLACE, immediately before it is translated for the engine.
 *
 *  Standing rules go on the system prompt (stable across the session → the engine's reusable
 *  prompt prefix is unaffected after turn one). Situational nudges are appended to the LAST user
 *  message instead of the system prompt for two reasons: they change from turn to turn, so putting
 *  them in the prefix would invalidate the whole cached prefix every time one fired; and the tail
 *  of the conversation is where a model actually acts on an instruction.
 *
 *  Returns the analysis so the caller can act on `forceTextOnly`. */
export function applyAgentGuidance(req: AnthropicRequest): TurnGuidance {
  const guidance = analyzeTurn(req)

  if (guidance.system.length > 0) {
    const text = guidance.system.join('\n\n')
    if (typeof req.system === 'string') req.system = `${req.system}\n\n${text}`
    else if (Array.isArray(req.system)) req.system = [...req.system, { type: 'text', text }]
    else req.system = text
  }

  if (guidance.nudges.length > 0) {
    const text = guidance.nudges.join('\n\n')
    const last = req.messages[req.messages.length - 1]
    // Only ever appended to a trailing USER message — that is where tool results live, so it is
    // both the natural home for a reaction to them and the last thing the model reads. When the
    // request ends on an assistant message the client is prefilling a reply, and injecting a user
    // turn there would corrupt that; the nudge is simply skipped, and lands on the next turn.
    if (last && last.role === 'user') {
      if (typeof last.content === 'string') last.content = `${last.content}\n\n${text}`
      else last.content = [...last.content, { type: 'text', text }]
    }
  }

  return guidance
}
