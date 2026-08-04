// Model-callable tool wrapping for Customize -> Agents (CustomChatAgent), same shape as
// routine-tools.ts's routine tools. Exists to close a real gap: create_routine's chat flavor
// requires an agentId naming an existing custom agent (routine-tools.ts, chat-runner.ts:50 only
// ever resolves against `customAgents`, never a built-in persona), but until now nothing let a
// model discover or create one — a chat-flavor routine could only ever be set up with a human
// manually checking Customize -> Agents and typing the id in by hand, or an external caller
// hitting the REST API directly. `list_agents`/`create_agent` give the model the same two
// operations chat-agent-routes.ts exposes over HTTP (GET /api/v1/chat-agents, POST
// /api/v1/chat-agents), so the whole "search web, wrap it in an agent, schedule it" flow can
// happen inside one chat turn.
//
// Both tools are deliberately ungated (no isCodeAuthorized check, unlike create_routine's code
// flavor): a CustomChatAgent is inert on its own — it is a system prompt + a tool allow-list that
// is only ever a SUBSET filter over tools this same caller could already reach (chat-runner.ts
// passes `agent.tools` as `allowedTools`, intersected against the real registry), never a grant of
// new capability. Creating one has exactly the same risk profile as the model composing a longer
// system-prompt string in its own reply — it cannot reach the filesystem/shell gate that makes
// code-flavor routines sensitive.
import { randomUUID } from 'node:crypto'
import type { CustomChatAgent } from '../config/config'

/** The narrow slice of ConfigStore these 2 tools touch. A real ConfigStore instance satisfies
 *  this structurally (TypeScript structural typing, same idiom as RoutineToolsStore in
 *  routine-tools.ts) — cli.ts just passes `store`. Kept narrow so tests can stub it with a plain
 *  object instead of a real ConfigStore. */
export interface AgentToolsStore {
  snapshot(): { customAgents: CustomChatAgent[] }
  update(fn: (cfg: { customAgents: CustomChatAgent[] }) => void): void
}

/** Mirrors chat-agent-routes.ts's own local cap — kept as a separate constant rather than a
 *  shared export because the two call sites (HTTP route, this tool) have no other reason to
 *  depend on each other, and config.ts's own CUSTOM_AGENT_CAP is a private validation-time
 *  backstop, not something either surface is meant to reach into. */
const AGENT_CAP = 50

function sanitizeStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// ── list_agents ──────────────────────────────────────────────────────────────

export const LIST_AGENTS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'list_agents',
    description:
      'List every custom chat agent from Customize -> Agents, with its id, name, description, and ' +
      'tools. Use this to find an agentId for create_routine\'s chat flavor, or to check whether a ' +
      'suitable one already exists before calling create_agent.',
    parameters: { type: 'object', properties: {} },
  },
}

export function execListAgents(_args: Record<string, unknown>, store: AgentToolsStore): string {
  const agents = store.snapshot().customAgents
  if (agents.length === 0) return 'No custom agents exist yet. Use create_agent to make one.'
  return agents
    .map((a) => `- ${a.id} "${a.name}" — ${a.description || '(no description)'} — tools: ${a.tools.join(', ') || '(none)'}`)
    .join('\n')
}

// ── create_agent ─────────────────────────────────────────────────────────────

export const CREATE_AGENT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_agent',
    description:
      'Create a new custom chat agent under Customize -> Agents: a named system prompt with a tool ' +
      'allow-list. Returns its id, which create_routine\'s chat flavor needs as agentId. Only ' +
      'available tools are web_search, fetch_url, run_code (no filesystem/shell access, same as any ' +
      'chat-flavor routine) plus any connected MCP tools already visible in this conversation.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short display name, e.g. "Job Search Assistant".' },
        description: { type: 'string', description: 'One sentence: what this agent is for.' },
        systemPrompt: { type: 'string', description: 'The system prompt this agent runs with.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool names this agent may call, e.g. ["web_search", "fetch_url"].' },
      },
      required: ['name'],
    },
  },
}

export function execCreateAgent(args: Record<string, unknown>, store: AgentToolsStore): string {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) return 'Error: name is required.'
  if (store.snapshot().customAgents.length >= AGENT_CAP) return `Error: agent limit reached (${AGENT_CAP}).`

  const agent: CustomChatAgent = {
    id: randomUUID(),
    name,
    description: typeof args.description === 'string' ? args.description.trim() : '',
    systemPrompt: typeof args.systemPrompt === 'string' ? args.systemPrompt : '',
    skillIds: [],
    tools: sanitizeStringArray(args.tools),
  }
  store.update((cfg) => { cfg.customAgents.push(agent) })
  return `Created agent ${agent.id} "${agent.name}".`
}
