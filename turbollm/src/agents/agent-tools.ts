// Agent tools for the CHAT loop (spec 13 redesign §1.2/§1.4).
//
// Phase-1 agents ride chat's existing ToolRegistry loop — NOT pi (pi is for the swarm,
// later). So these tools are produced in the SAME shape ToolRegistry uses: an OpenAI
// `ToolDefinition` + an `execute(call) => string`. Every filesystem call runs through the
// hardened `makeToolCallGuard` (read = readRoots, write = ~/.turbollm). Script execution
// is the existing compute-only `run_code` sandbox (node:vm, no real FS) — writes happen
// ONLY through the guarded write_file tool, never from inside a script.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, dirname } from 'node:path'
import type { AgentType } from '../config/config'
import type { ToolDefinition, ToolCall } from '../tools/tool-registry'
import { makeToolCallGuard, type ToolCallGuard } from './fs-guard'
import { execRunCode } from '../tools/builtin'

const MAX_BYTES = 1_048_576 // 1 MB
const MAX_GLOB_RESULTS = 5000
const MAX_GLOB_DEPTH = 25

// ── Tool definitions (OpenAI shape, for the `tools` array sent to the engine) ─────

const READ_FILE_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from an allowed folder. Size-capped at 1 MB.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file' } }, required: ['path'] },
  },
}
const LIST_DIR_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_dir',
    description: 'List entries in a directory within an allowed folder.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the directory' } }, required: ['path'] },
  },
}
const GLOB_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'glob',
    description: 'Find files matching a glob pattern under a root directory (must be an allowed folder).',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.md' }, root: { type: 'string', description: 'Absolute root directory to search from (an allowed folder)' } }, required: ['pattern', 'root'] },
  },
}
const WRITE_FILE_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file. Only the agent\'s own data folder is writable; computed content from run_code should be persisted here.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to write (within the writable folder)' }, content: { type: 'string', description: 'File content' } }, required: ['path', 'content'] },
  },
}
const RUN_CODE_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_code',
    description: 'Execute a JavaScript snippet for computation/transformation. Use `return` to produce the result. Sandboxed: NO file, network, or process access. To save a result to disk, return it then call write_file.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript. Use `return <value>` to return the result.' } }, required: ['code'] },
  },
}
const SAVE_SKILL_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'save_skill',
    description: 'Save a reusable SKILL into the shared skill library (a SKILL.md file under ~/.turbollm/skills). Call this ONLY when the user EXPLICITLY asks to create or save a skill from this conversation (e.g. "make a skill out of this", "save this as a skill"). Do NOT call it proactively or suggest it on your own. This is the only way skills are saved — never use any external memory, knowledge-graph, or note tool.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case id, e.g. "csv-summary"' },
        description: { type: 'string', description: 'One sentence: when to apply this skill' },
        procedure: { type: 'string', description: 'Concise step-by-step procedure (markdown)' },
      },
      required: ['name', 'procedure'],
    },
  },
}

// Skill id → which tool defs it grants. (Phase 1: a small built-in mapping; the skill
// library / grown skills come in later phases.)
const SKILL_TOOLS: Record<string, ToolDefinition[]> = {
  filesystem: [READ_FILE_DEF, LIST_DIR_DEF, GLOB_DEF, WRITE_FILE_DEF],
  code: [RUN_CODE_DEF],
}

/** The bundle the chat loop needs for an agent-bound conversation. */
export interface AgentToolset {
  defs: ToolDefinition[]
  execute: (call: ToolCall) => string
  /** Tool names this agent owns — the chat loop routes ONLY these here; everything else
   *  (web_search/mcp/…) stays with the normal ToolRegistry. */
  names: Set<string>
}

export interface AgentToolsetOpts {
  /** When provided, the agent gets a `save_skill` tool that triggers this (the in-chat
   *  skill author). Returns a short message shown back to the model as the tool result. */
  onSaveSkill?: (args: { name?: string; description?: string; procedure?: string }) => string
}

/** Build the agent's tools + a guarded executor in ToolRegistry shape. */
export function buildAgentToolset(agent: AgentType, dataDir: string, opts: AgentToolsetOpts = {}): AgentToolset {
  // Resolve which tool defs this agent's skills grant (dedup by name).
  const wildcard = agent.skills.includes('*')
  const defsByName = new Map<string, ToolDefinition>()
  for (const [skillId, defs] of Object.entries(SKILL_TOOLS)) {
    if (wildcard || agent.skills.includes(skillId)) {
      for (const d of defs) defsByName.set(d.function.name, d)
    }
  }
  // Every agent can author skills from chat (skill-creator model) — independent of which
  // tool-skills it has enabled.
  if (opts.onSaveSkill) defsByName.set(SAVE_SKILL_DEF.function.name, SAVE_SKILL_DEF)
  const defs = [...defsByName.values()]
  const names = new Set(defs.map((d) => d.function.name))
  // The guard: write confined to ~/.turbollm (the fixed root), read to the agent's
  // readRoots. bridgedNames is empty — these tools are all FS/code, handled explicitly.
  const guard: ToolCallGuard = makeToolCallGuard(agent, dataDir, new Set())

  const execute = (call: ToolCall): string => {
    if (!names.has(call.name)) return `Error: tool "${call.name}" is not available to this agent.`
    // run_code is compute-only (no path) — no guard needed; the sandbox has no FS.
    if (call.name === 'run_code') return execRunCode(call.args, false)
    // save_skill triggers the background skill author; no FS guard (writes to the library).
    if (call.name === 'save_skill') {
      if (!opts.onSaveSkill) return 'Error: saving skills is not available in this conversation.'
      return opts.onSaveSkill({
        name: typeof call.args.name === 'string' ? call.args.name : undefined,
        description: typeof call.args.description === 'string' ? call.args.description : undefined,
        procedure: typeof call.args.procedure === 'string' ? call.args.procedure : undefined,
      })
    }

    // Every FS tool is gated by the guard FIRST (canonicalizes + containment-checks).
    const verdict = guard(call.name, call.args)
    if ('block' in verdict) return `Denied: ${verdict.reason}`

    try {
      switch (call.name) {
        case 'read_file': return readFile(String(call.args.path))
        case 'list_dir': return listDir(String(call.args.path))
        case 'glob': return globFiles(String(call.args.pattern), String(call.args.root))
        case 'write_file': return writeFile(String(call.args.path), String(call.args.content ?? ''))
        default: return `Error: unknown tool "${call.name}"`
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  return { defs, execute, names }
}

// ── Raw FS operations (run only AFTER the guard has allowed the path) ─────────────

function readFile(path: string): string {
  if (!existsSync(path)) return `File not found: ${path}`
  const st = statSync(path)
  if (!st.isFile() || st.size > MAX_BYTES) return `File too large or not a regular file (max ${MAX_BYTES} bytes).`
  return readFileSync(path, 'utf8')
}

function listDir(path: string): string {
  if (!existsSync(path)) return `Directory not found: ${path}`
  const entries = readdirSync(path, { withFileTypes: true })
  return entries.map((e: Dirent) => (e.isDirectory() ? 'd ' : 'f ') + e.name).join('\n') || '(empty)'
}

function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return `Written ${content.length} bytes to ${path}`
}

function globFiles(pattern: string, root: string): string {
  const results: string[] = []
  let truncated = false
  const visit = (dir: string, depth: number): void => {
    if (truncated || depth > MAX_GLOB_DEPTH) return
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (results.length >= MAX_GLOB_RESULTS) { truncated = true; return }
      const child = join(dir, e.name)
      if (matchGlob(child, pattern)) results.push(child)
      if (e.isDirectory()) visit(child, depth + 1) // symlinked dirs report isDirectory()===false
    }
  }
  if (existsSync(root) && statSync(root).isDirectory()) visit(root, 0)
  return results.join('\n') + (truncated ? `\n…(truncated at ${MAX_GLOB_RESULTS})` : '') || '(no matches)'
}

function matchGlob(path: string, pattern: string): boolean {
  const re = pattern
    .replace(/[.*+^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*\\\*/g, '<<S>>').replace(/\\\*/g, '<<s>>')
    .replace(/<<S>>/g, '.*').replace(/<<s>>/g, '[^/\\\\]*')
  try { return new RegExp(`^${re}$`).test(path) } catch { return false }
}
