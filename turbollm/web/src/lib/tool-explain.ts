import { friendlyName } from '../screens/chat/MessageBubble'

/** Short, one-line human-readable summary of what a tool call is about to run.
 *  Used in the approval bar (and optionally as a tool-call card tooltip). */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === 'web_search') return `Search the web for "${String(args.query)}"`
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
