// Tool approval-gate policy resolution (F-019 replacement).
// Every tool defaults to 'ask' (must prompt the user) unless a policy has been
// explicitly set — either globally (Settings → Tools) or per-conversation
// (the "Allow for this chat" action). This is a deliberate behavior change:
// previously nothing prompted except the (broken) run_code confirmation stub.
export type ToolPolicy = 'ask' | 'allow' | 'deny'

/** Tools that ask before every call whatever is set (GitHub #52): a global or chat Allow, "Always Allow" and
 *  Auto-allow all would let later calls run unseen. Only a Deny changes them. run_python runs model-written code, and
 *  seeing each run before it starts is v1's defence against prompt injection steering it (the sandbox protects the
 *  machine, not the chat's own data). */
export const ALWAYS_ASK_TOOLS: ReadonlySet<string> = new Set(['run_python'])

/** Per-conversation override wins over the global default; falling through to 'ask'
 *  when neither is set (safe-by-default: a brand-new/unclassified tool always prompts).
 *  `autoAllowAll` (Settings → Tool permissions master toggle) only silences a resolved
 *  'ask' — it never overrides an explicit 'deny' (global or per-conversation), which
 *  stays a deliberate decision the user already made.
 *
 *  Except a global 'deny', which no chat's "Allow for this chat" overrides: Deny in Settings is
 *  the owner's word for every chat, and the override is saved by the approve route for any caller
 *  lanAuth lets into a chat (a keyless open-LAN peer, Serve identity or Access login, or a remote
 *  token among them), so letting it win made Deny advice in any chat such a caller could reach. */
export function resolveToolPolicy(
  name: string,
  globalPolicies: Record<string, ToolPolicy>,
  convOverrides: Record<string, 'allow' | 'deny'>,
  autoAllowAll = false,
): ToolPolicy {
  const global = globalPolicies[name]
  if (global === 'deny') return 'deny'
  if (ALWAYS_ASK_TOOLS.has(name)) return convOverrides[name] === 'deny' ? 'deny' : 'ask'
  if (convOverrides[name]) return convOverrides[name]
  if (global) return global === 'ask' && autoAllowAll ? 'allow' : global
  return autoAllowAll ? 'allow' : 'ask'
}
