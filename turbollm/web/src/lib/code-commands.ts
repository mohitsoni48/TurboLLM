// The single canonical registry of the Code composer's BUILT-IN commands (ADR-260). Before this,
// the same knowledge lived in two places that had to be hand-synced: the `/` picker's displayed
// list (assembled inline where CodeComposer's `slashCommands` prop is passed) and CodeSessionScreen
// `send()`'s standalone trigger regexes (COMPACT_RE/CLEAR_RE/RESUME_RE). Both now source from here,
// so adding/removing a built-in is a single edit to CODE_COMMANDS.
//
// Deliberately plain TS, zero React — the picker and send() consume it, and a hypothetical future
// `turbollm code` CLI (the same reusability motive as ADR-260's SSE-orchestration extraction) can
// reuse the exact same triggers/descriptions. The per-command SIDE EFFECT (call the compact
// endpoint, clear the session, …) stays with the caller: this module says WHICH command an input
// is and WHETHER it belongs in the picker, the caller maps the id to its handler.
//
// NOT built-in and intentionally NOT here: dynamic skills (from the shared skill library) — those
// are appended to the picker and matched separately (skillPromptOverride), since they're
// data-driven, not a fixed part of the composer's command vocabulary.

/** Session state that affects which built-ins are offered in the picker right now. */
export interface CodeCommandContext {
  /** The session has hidden history (a `/clear` or a revert) that `/resume` can bring back. */
  cleared: boolean
}

export interface CodeCommandDef {
  id: string
  /** Shown in the `/` picker. */
  description: string
  /** Matches the WHOLE composer input when this command is invoked (anchored `^…$`). A capture
   *  group, where present, carries the command's argument (e.g. `/compact <instructions>`). */
  pattern: RegExp
  /** Whether this command appears in the `/` picker for the given state — default: always. Note
   *  this gates DISPLAY only; {@link matchCodeCommand} matches regardless of picker visibility
   *  (e.g. `/resume` is always parseable; the endpoint 409s when there's nothing to resume, and
   *  the picker just hides the entry so it isn't offered when it can't do anything). */
  pickerVisible?: (ctx: CodeCommandContext) => boolean
}

// Order matters only for {@link matchCodeCommand}'s first-match scan; the built-ins have disjoint
// triggers so today it's immaterial, but a new command should still be ordered so a more specific
// trigger can't be shadowed by a broader earlier one.
//
// How each built-in is dispatched (in CodeSessionScreen's send()) differs by kind, but adding one
// is still a SINGLE entry here + one dispatch arm — no second place to update:
//   • compact/clear/resume → a dedicated endpoint, early-return (not a model turn).
//   • init → a REAL agentic turn with a fixed promptOverride (the agent inspects the repo and
//     writes AGENTS.md) — flows through startCodeRun, no early return.
//   • details/thinking → an instant client-side display toggle (code-display-prefs.ts), early-return.
//
//   • shell (`!`/`!!`, ADR-258) → NOT a model turn: runs a user shell command via the exec
//     endpoint. `pickerVisible: () => false` since it's `!`-triggered, never in the `/` list; still
//     matched here so send() dispatches it. `match[1]` is the bang (`!` feeds output to the model,
//     `!!` doesn't), `match[2]` the command.
export const CODE_COMMANDS: CodeCommandDef[] = [
  {
    id: 'compact',
    description: 'Summarize the conversation so far into one summary, to free up context',
    pattern: /^\/compact\b\s*(.*)$/i,
  },
  {
    id: 'clear',
    description: 'Clear the chat — repo, worktree, and branch stay as they are',
    pattern: /^\/clear\b\s*$/i,
  },
  {
    id: 'resume',
    description: 'Bring back a cleared or reverted chat',
    pattern: /^\/resume\b\s*$/i,
    pickerVisible: (ctx) => ctx.cleared,
  },
  {
    id: 'init',
    description: 'Set up an AGENTS.md — the agent inspects your repo and drafts one',
    pattern: /^\/init\b\s*$/i,
  },
  {
    id: 'details',
    description: 'Toggle showing full tool-call details for every step',
    pattern: /^\/details\b\s*$/i,
  },
  {
    id: 'thinking',
    description: "Toggle always showing the agent's reasoning",
    pattern: /^\/thinking\b\s*$/i,
  },
  {
    id: 'shell',
    description: 'Run a shell command yourself (! feeds output to the model, !! does not)',
    // `!` or `!!` followed by a non-empty command. match[1] = the bang(s), match[2] = the command.
    // The `(?!!)` stops the bang group from giving a bang back to the command via backtracking (so
    // `!!` + only whitespace is NOT read as single-bang command `!`); the `\S` guard means a lone
    // `!`/`!!` with no command doesn't match at all — it stays a normal message.
    pattern: /^(!{1,2})(?!!)\s*(\S[\s\S]*)$/,
    pickerVisible: () => false,
  },
]

/** The built-in command whose trigger matches this exact input, if any — with the raw regex match
 *  so the caller can read a captured argument (e.g. `/compact foo` → `match[1] === 'foo'`).
 *  Ignores picker visibility (a command is parseable whether or not it's currently offered). */
export function matchCodeCommand(text: string): { id: string; match: RegExpExecArray } | null {
  for (const cmd of CODE_COMMANDS) {
    const m = cmd.pattern.exec(text)
    if (m) return { id: cmd.id, match: m }
  }
  return null
}

/** The built-in commands to show in the `/` picker for the current session state, as the
 *  `{ id, description }` shape CodeComposer's `slashCommands` prop expects. Callers append their
 *  dynamic skills to this. */
export function pickerCodeCommands(ctx: CodeCommandContext): { id: string; description: string }[] {
  return CODE_COMMANDS
    .filter((cmd) => !cmd.pickerVisible || cmd.pickerVisible(ctx))
    .map((cmd) => ({ id: cmd.id, description: cmd.description }))
}
