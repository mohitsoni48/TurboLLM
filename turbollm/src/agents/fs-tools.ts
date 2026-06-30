// Custom filesystem tools for pi agent sessions (spec 13 §4.1)
// Defined as pi defineTool instances — not granted to any agent unless skills include them.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const MAX_BYTES = 1_048_576 // 1 MB

export function createReadFileTool() {
  return defineTool({
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file. Size-capped at 1 MB.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to the file' }),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      if (!existsSync(params.path)) {
        return { content: [{ type: 'text' as const, text: `File not found: ${params.path}` }], details: undefined }
      }
      const st = statSync(params.path)
      if (!st.isFile() || st.size > MAX_BYTES) {
        return { content: [{ type: 'text' as const, text: `File too large or not a regular file (max ${MAX_BYTES} bytes)` }], details: undefined }
      }
      try {
        return { content: [{ type: 'text' as const, text: readFileSync(params.path, 'utf8') }], details: undefined }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Read error: ${e instanceof Error ? e.message : String(e)}` }], details: undefined }
      }
    },
  })
}

export function createListDirTool() {
  return defineTool({
    name: 'list_dir',
    label: 'List Directory',
    description: 'List entries in a directory.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to the directory' }),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      if (!existsSync(params.path)) {
        return { content: [{ type: 'text' as const, text: `Directory not found: ${params.path}` }], details: undefined }
      }
      const entries = readDirEntries(params.path)
      return { content: [{ type: 'text' as const, text: entries.map(e => e.isDir ? 'd ' + e.name : 'f ' + e.name).join('\n') }], details: undefined }
    },
  })
}

export function createGlobTool() {
  return defineTool({
    name: 'glob',
    label: 'Glob Files',
    description: 'Find files matching a glob pattern.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern to match' }),
      root: Type.Optional(Type.String({ description: 'Root directory to search from' })),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      const results = globMatch(params.pattern, params.root)
      return { content: [{ type: 'text' as const, text: results.join('\n') }], details: undefined }
    },
  })
}

export function createWriteFileTool() {
  return defineTool({
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file. Only works within allowed write roots.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to write to' }),
      content: Type.String({ description: 'File content' }),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      try {
        writeFileSync(params.path, params.content, 'utf8')
        return { content: [{ type: 'text' as const, text: `Written to ${params.path}` }], details: undefined }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Write error: ${e instanceof Error ? e.message : String(e)}` }], details: undefined }
      }
    },
  })
}

function readDirEntries(path: string): { name: string; isDir: boolean }[] {
  const entries = readdirSync(path, { withFileTypes: true })
  return entries.map((e: Dirent) => ({ name: e.name, isDir: e.isDirectory() }))
}

function globMatch(pattern: string, root?: string): string[] {
  function walk(dir: string): string[] {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
    const entries = readdirSync(dir, { withFileTypes: true })
    const results: string[] = []
    for (const e of entries) {
      const child = join(dir, e.name)
      results.push(child)
      if (e.isDirectory()) results.push(...walk(child))
    }
    return results
  }

  const searchRoot = root || process.cwd()
  const allPaths = walk(searchRoot)
  return allPaths.filter(p => simpleMatch(p, pattern))
}

function simpleMatch(path: string, pattern: string): boolean {
  // Convert glob pattern to regex-like matching
  // Support ** (any depth), * (single segment), ? (single char)
  const regex = pattern
    .replace(/[.*+^${}()|[\]\\]/g, '\\$&')
    .replace(/\\*\\*/g, '<<<STARSTAR>>>')
    .replace(/\\*/g, '<<<STAR>>>')
    .replace(/<<<STARSTAR>>>/g, '.*')
    .replace(/<<<STAR>>>/g, '[^/]*')
  return new RegExp(`^${regex}$`).test(path)
}
