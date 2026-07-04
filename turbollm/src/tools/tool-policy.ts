// Tool approval-gate policy resolution (F-019 replacement).
// Every tool defaults to 'ask' (must prompt the user) unless a policy has been
// explicitly set — either globally (Settings → Tools) or per-conversation
// (the "Allow for this chat" action). This is a deliberate behavior change:
// previously nothing prompted except the (broken) run_code confirmation stub.
export type ToolPolicy = 'ask' | 'allow' | 'deny'

/** Per-conversation override wins over the global default; falling through to 'ask'
 *  when neither is set (safe-by-default: a brand-new/unclassified tool always prompts). */
export function resolveToolPolicy(
  name: string,
  globalPolicies: Record<string, ToolPolicy>,
  convOverrides: Record<string, 'allow' | 'deny'>,
): ToolPolicy {
  if (convOverrides[name]) return convOverrides[name]
  if (globalPolicies[name]) return globalPolicies[name]
  return 'ask'
}
