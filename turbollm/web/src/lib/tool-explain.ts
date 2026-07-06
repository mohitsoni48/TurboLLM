import { friendlyName } from '../screens/chat/MessageBubble'

/** PURE: mirrors resolveSearchQuery in src/tools/builtin.ts — the schema declares a single
 *  required `query: string`, but a model sometimes emits `queries: string[]` instead (seen from
 *  a small local model whose tool-calling drifted from the declared schema); fall back to the
 *  first entry rather than rendering the literal string "undefined" in the approval dialog. */
function resolveSearchQuery(args: Record<string, unknown>): string {
  if (typeof args.query === 'string') return args.query
  if (Array.isArray(args.queries) && typeof args.queries[0] === 'string') return args.queries[0]
  return ''
}

/** Short, one-line human-readable summary of what a tool call is about to run.
 *  Used in the approval bar (and optionally as a tool-call card tooltip). */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === 'web_search') return `Search the web for "${resolveSearchQuery(args)}"`
  if (name === 'fetch_url') return `Fetch ${String(args.url)}`
  if (name === 'run_code') {
    const code = String(args.code)
    return `Run JavaScript: ${code.slice(0, 80)}${code.length > 80 ? '…' : ''}`
  }
  if (name.startsWith('mcp__')) {
    const match = name.match(/^mcp__([^_]+(?:_[^_]+)*)__/)
    const server = match?.[1] ?? 'server'
    return `Call "${friendlyName(name)}" on ${server}`
  }
  return `Run "${name}"`
}
