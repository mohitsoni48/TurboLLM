// The Code agent's grep and find, with rg and fd started through util/tether.ts. pi's own tools (core/tools/grep.js
// and find.js) start rg and fd with a raw `spawn` that no GrepOperations or FindOperations can replace (those cover
// reading a file and a custom glob, never the search process). So a daemon that died during a search left rg or fd
// running, parented to init, and a search with no match writes nothing until it finishes, so it did not even die at
// its next write: measured, a raw rg over `/` with pi's arguments was alive with ppid 1 three seconds after its
// daemon's SIGKILL, and a tethered one was gone.
//
// What is pi's: each tool's definition (name, label, description, schema, prompt snippet, renderers), taken from
// createGrepToolDefinition and createFindToolDefinition, so the model sees exactly pi's tools. What is TurboLLM's:
// `execute`, ported from pi 0.80.6 (@earendil-works/pi-coding-agent, MIT) with two changes only. rg and fd run
// through spawnTethered, and the program is found the way pi's getToolPath finds it (pi's managed bin dir, then
// PATH, fd also as `fdfind`), since its ensureTool is not exported. When neither has it, pi's own tool runs once over
// an empty directory, so its ensureTool can download it (that one rg or fd is raw, but searches nothing and exits
// within milliseconds), and the lookup runs again. pi's `exports` reach only its entry point, so what the port needs
// of pi that it does not export (resolveToCwd and the path normalizing under it, pathExists, GREP_MAX_LINE_LENGTH) is
// copied below. search-tools.test.ts runs both tools on a
// fixture matrix and requires identical results; pi is pinned exactly, and spawning-deps.test.ts fails on any bump.
//
// Registered as customTools, which replace pi's built-ins of the same name, ONLY where the mode's tool allowlist
// names them (plan mode). pi activates every custom tool when there is no allowlist (auto and ask mode, whose active
// set is read, bash, edit and write), so registering them there would have given those modes two tools they never had.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { access, readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  getAgentDir,
  truncateHead,
  truncateLine,
  type FindToolDetails,
  type GrepToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { resolveLikeExec, spawnTethered } from '../util/tether'

/** pi's GREP_MAX_LINE_LENGTH (core/tools/truncate.js), which truncateLine applies by default; not exported. */
const GREP_MAX_LINE_LENGTH = 500
const GREP_DEFAULT_LIMIT = 100
const FIND_DEFAULT_LIMIT = 1000

export type SearchTool = 'rg' | 'fd'

export interface SearchToolDeps {
  /** pi's managed-binaries dir, where its ensureTool downloads rg and fd (its getBinDir(): `<getAgentDir()>/bin`). */
  binDir?: () => string
  /** The environment whose PATH is searched after it (the daemon's). */
  env?: NodeJS.ProcessEnv
  /** pi's own tool, run once over an empty directory so its ensureTool downloads a missing rg or fd. */
  warmUp?: (tool: SearchTool, signal: AbortSignal | undefined) => Promise<void>
  /** The OS whose lookup rules apply (process.platform; tests take Windows' on any OS). */
  platform?: NodeJS.Platform
  /** The directory Windows looks in first for a bare name: the daemon's own, as rg and fd are spawned without a cwd. */
  daemonCwd?: () => string
}

// ── pi's helpers that its package does not export (core/tools/path-utils.js, utils/paths.js) ──────────────────────

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** pi's normalizePath: unicode spaces and a leading `@` only when asked, `~` expanded, a file:// URL accepted. */
function normalizePath(input: string, o: { normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean } = {}): string {
  let normalized = input
  if (o.normalizeUnicodeSpaces) normalized = normalized.replace(UNICODE_SPACES, ' ')
  if (o.stripAtPrefix && normalized.startsWith('@')) normalized = normalized.slice(1)
  if (normalized === '~') return homedir()
  if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) return path.join(homedir(), normalized.slice(2))
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized)
  return normalized
}

/** pi's resolveToCwd (resolvePath with unicode spaces normalized and a leading `@` stripped). */
function resolveToCwd(filePath: string, cwd: string): string {
  const normalized = normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true })
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(normalizePath(cwd), normalized)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

// ── Finding rg and fd, as pi's getToolPath does ────────────────────────────────────────────────────────────────

/** Whether a spawn of the bare `name` finds a program, which is what pi asks by running `<name> --version`. POSIX:
 *  execvp's own rules (util/tether.ts). Windows: libuv's search_path (src/win/process.c), which the spawn itself then
 *  runs (spawnTethered is a plain spawn there). A lookup that searched less than libuv (PATH alone, or a quoted entry
 *  taken literally) would send a search the spawn could run to pi's warm-up instead, which then fails with "not
 *  available" where pi's own tool, asking libuv, finds the program. */
function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, daemonCwd: () => string): boolean {
  if (platform !== 'win32') return resolveLikeExec(name, { env }) !== null
  const cwd = daemonCwd()
  // The cwd first, unless NoDefaultCurrentDirectoryInExePath is set (NeedCurrentDirectoryForExePathW).
  const dirs = env.NoDefaultCurrentDirectoryInExePath === undefined ? [cwd] : []
  for (const dir of windowsPathDirs(windowsPathValue(env))) dirs.push(path.resolve(cwd, dir))
  // A name without an extension is tried as `<name>.com`, then `<name>.exe`; a directory is not a program.
  return dirs.some((dir) => ['.com', '.exe'].some((ext) => isFile(path.join(dir, name + ext))))
}

/** PATH, whatever its case (libuv finds it in the environment block case-insensitively, as Windows does). */
function windowsPathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (key === undefined ? undefined : env[key]) ?? ''
}

/** PATH's entries as libuv's search_path splits them: at `;`, except inside an entry that opens with a quote (`"` or
 *  `'`), which runs to its closing quote; a leading and a trailing quote are dropped; an empty entry is skipped.
 *  Relative entries are resolved from the cwd by the caller. */
function windowsPathDirs(value: string): string[] {
  const dirs: string[] = []
  let i = 0
  while (i < value.length) {
    const quote = value[i] === '"' || value[i] === "'" ? value[i] : null
    const close = quote === null ? i : value.indexOf(quote, i + 1)
    let end = value.indexOf(';', close === -1 ? value.length : close)
    if (end === -1) end = value.length
    if (end > i) {
      let dir = value.slice(i, end)
      if (dir.startsWith('"') || dir.startsWith("'")) dir = dir.slice(1)
      if (dir.endsWith('"') || dir.endsWith("'")) dir = dir.slice(0, -1)
      dirs.push(dir)
    }
    i = end + 1
  }
  return dirs
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** The program pi would run for `tool`: its managed copy first, then `rg`, or `fd` and `fdfind`, on PATH (a bare
 *  name, as pi returns it). null when neither has one. */
export function findSearchTool(tool: SearchTool, deps: SearchToolDeps = {}): string | null {
  const platform = deps.platform ?? process.platform
  const managed = path.join((deps.binDir ?? (() => path.join(getAgentDir(), 'bin')))(), tool + (platform === 'win32' ? '.exe' : ''))
  if (isFile(managed)) return managed
  const env = deps.env ?? process.env
  for (const name of tool === 'fd' ? ['fd', 'fdfind'] : ['rg']) {
    if (onPath(name, env, platform, deps.daemonCwd ?? (() => process.cwd()))) return name
  }
  return null
}

/** pi's own tool over an empty directory: its ensureTool finds or downloads the program (silently, as pi's tools
 *  ask), and the search it then runs finds nothing at once. Its rejection ("… is not available and could not be
 *  downloaded") is pi's own, and is passed on as the tool's error. */
async function piWarmUp(tool: SearchTool, signal: AbortSignal | undefined): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'turbollm-search-warmup-'))
  try {
    if (tool === 'rg') await createGrepToolDefinition(dir).execute('turbollm-warmup', { pattern: 'x' }, signal, undefined, undefined as never)
    else await createFindToolDefinition(dir).execute('turbollm-warmup', { pattern: 'x' }, signal, undefined, undefined as never)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** findSearchTool, after pi's warm-up when neither its bin dir nor PATH has the program. */
async function ensureSearchTool(tool: SearchTool, deps: SearchToolDeps, signal: AbortSignal | undefined): Promise<string | null> {
  const found = findSearchTool(tool, deps)
  if (found) return found
  await (deps.warmUp ?? piWarmUp)(tool, signal)
  return findSearchTool(tool, deps)
}

// ── grep: pi 0.80.6's execute, with rg tethered ───────────────────────────────────────────────────────────────

type GrepDefinition = ReturnType<typeof createGrepToolDefinition>
type FindDefinition = ReturnType<typeof createFindToolDefinition>

function grepExecute(cwd: string, deps: SearchToolDeps): GrepDefinition['execute'] {
  return async (_toolCallId, { pattern, path: searchDir, glob, ignoreCase, literal, context, limit }, signal) => {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Operation aborted'))
        return
      }
      let settled = false
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      void (async () => {
        try {
          const rgPath = await ensureSearchTool('rg', deps, signal)
          if (!rgPath) {
            settle(() => reject(new Error('ripgrep (rg) is not available and could not be downloaded')))
            return
          }
          const searchPath = resolveToCwd(searchDir || '.', cwd)
          let isDirectory: boolean
          try {
            isDirectory = (await fsStat(searchPath)).isDirectory()
          } catch {
            settle(() => reject(new Error(`Path not found: ${searchPath}`)))
            return
          }
          const contextValue = context && context > 0 ? context : 0
          const effectiveLimit = Math.max(1, limit ?? GREP_DEFAULT_LIMIT)
          const formatPath = (filePath: string) => {
            if (isDirectory) {
              const relative = path.relative(searchPath, filePath)
              if (relative && !relative.startsWith('..')) return relative.replace(/\\/g, '/')
            }
            return path.basename(filePath)
          }
          const fileCache = new Map<string, string[]>()
          const getFileLines = async (filePath: string) => {
            let lines = fileCache.get(filePath)
            if (!lines) {
              try {
                const content = await fsReadFile(filePath, 'utf-8')
                lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
              } catch {
                lines = []
              }
              fileCache.set(filePath, lines)
            }
            return lines
          }
          const args = ['--json', '--line-number', '--color=never', '--hidden']
          if (ignoreCase) args.push('--ignore-case')
          if (literal) args.push('--fixed-strings')
          if (glob) args.push('--glob', glob)
          args.push('--', pattern, searchPath)
          // The one change from pi: tied to the daemon, so a search the daemon does not live to read ends with it.
          const child = spawnTethered(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'probe' })
          const rl = createInterface({ input: child.stdout! })
          let stderr = ''
          let matchCount = 0
          let matchLimitReached = false
          let linesTruncated = false
          let aborted = false
          let killedDueToLimit = false
          const outputLines: string[] = []
          const cleanup = () => {
            rl.close()
            signal?.removeEventListener('abort', onAbort)
          }
          const stopChild = (dueToLimit = false) => {
            if (!child.killed) {
              killedDueToLimit = dueToLimit
              child.kill()
            }
          }
          const onAbort = () => {
            aborted = true
            stopChild()
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
          })
          const formatBlock = async (filePath: string, lineNumber: number) => {
            const relativePath = formatPath(filePath)
            const lines = await getFileLines(filePath)
            if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`]
            const block: string[] = []
            const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber
            const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber
            for (let current = start; current <= end; current++) {
              const lineText = lines[current - 1] ?? ''
              const sanitized = lineText.replace(/\r/g, '')
              const isMatchLine = current === lineNumber
              const { text: truncatedText, wasTruncated } = truncateLine(sanitized)
              if (wasTruncated) linesTruncated = true
              if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`)
              else block.push(`${relativePath}-${current}- ${truncatedText}`)
            }
            return block
          }
          const matches: Array<{ filePath: string; lineNumber: number; lineText: string | undefined }> = []
          rl.on('line', (line) => {
            if (!line.trim() || matchCount >= effectiveLimit) return
            let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
            try {
              event = JSON.parse(line) as typeof event
            } catch {
              return
            }
            if (event.type === 'match') {
              matchCount++
              const filePath = event.data?.path?.text
              const lineNumber = event.data?.line_number
              const lineText = event.data?.lines?.text
              if (filePath && typeof lineNumber === 'number') matches.push({ filePath, lineNumber, lineText })
              if (matchCount >= effectiveLimit) {
                matchLimitReached = true
                stopChild(true)
              }
            }
          })
          child.on('error', (error) => {
            cleanup()
            settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)))
          })
          child.on('close', async (code) => {
            cleanup()
            if (aborted) {
              settle(() => reject(new Error('Operation aborted')))
              return
            }
            if (!killedDueToLimit && code !== 0 && code !== 1) {
              const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`
              settle(() => reject(new Error(errorMsg)))
              return
            }
            if (matchCount === 0) {
              settle(() => resolve({ content: [{ type: 'text', text: 'No matches found' }], details: undefined }))
              return
            }
            for (const match of matches) {
              if (contextValue === 0 && match.lineText !== undefined) {
                const relativePath = formatPath(match.filePath)
                const sanitized = match.lineText.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n$/, '')
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized)
                if (wasTruncated) linesTruncated = true
                outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`)
              } else {
                const block = await formatBlock(match.filePath, match.lineNumber)
                outputLines.push(...block)
              }
            }
            const rawOutput = outputLines.join('\n')
            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })
            let output = truncation.content
            const details: GrepToolDetails = {}
            const notices: string[] = []
            if (matchLimitReached) {
              notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`)
              details.matchLimitReached = effectiveLimit
            }
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
              details.truncation = truncation
            }
            if (linesTruncated) {
              notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`)
              details.linesTruncated = true
            }
            if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`
            settle(() => resolve({
              content: [{ type: 'text', text: output }],
              details: Object.keys(details).length > 0 ? details : undefined,
            }))
          })
        } catch (err) {
          settle(() => reject(err))
        }
      })()
    })
  }
}

// ── find: pi 0.80.6's execute (its fd path; TurboLLM passes no custom glob), with fd tethered ────────────────────

function findExecute(cwd: string, deps: SearchToolDeps): FindDefinition['execute'] {
  return async (_toolCallId, { pattern, path: searchDir, limit }, signal) => {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Operation aborted'))
        return
      }
      let settled = false
      let stopChild: (() => void) | undefined
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        stopChild = undefined
        fn()
      }
      const onAbort = () => {
        stopChild?.()
        settle(() => reject(new Error('Operation aborted')))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      void (async () => {
        try {
          const searchPath = resolveToCwd(searchDir || '.', cwd)
          const effectiveLimit = limit ?? FIND_DEFAULT_LIMIT
          const fdPath = await ensureSearchTool('fd', deps, signal)
          if (signal?.aborted) {
            settle(() => reject(new Error('Operation aborted')))
            return
          }
          if (!fdPath) {
            settle(() => reject(new Error('fd is not available and could not be downloaded')))
            return
          }
          const args = ['--glob', '--color=never', '--hidden']
          // fd normally ignores .gitignore outside git repos, so keep --no-require-git there. Inside repos, use fd's
          // default git-aware behavior so parent .gitignore rules stop at nested repo boundaries (pi's own comment,
          // earendil-works/pi#5960).
          let insideGitRepo = false
          for (let current = searchPath; ;) {
            if (await pathExists(path.join(current, '.git'))) {
              insideGitRepo = true
              break
            }
            const parent = path.dirname(current)
            if (parent === current) break
            current = parent
          }
          if (!insideGitRepo) args.push('--no-require-git')
          args.push('--max-results', String(effectiveLimit))
          // fd --glob matches against the basename unless --full-path is set; in --full-path mode it matches against
          // the absolute candidate path, so a path-containing pattern like 'src/**/*.spec.ts' needs a leading '**/'.
          let effectivePattern = pattern
          if (pattern.includes('/')) {
            args.push('--full-path')
            if (!pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**') effectivePattern = `**/${pattern}`
          }
          args.push('--', effectivePattern, searchPath)
          // The one change from pi: tied to the daemon.
          const child = spawnTethered(fdPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'probe' })
          const rl = createInterface({ input: child.stdout! })
          let stderr = ''
          const lines: string[] = []
          stopChild = () => {
            if (!child.killed) child.kill()
          }
          const cleanup = () => {
            rl.close()
          }
          child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
          })
          rl.on('line', (line) => {
            lines.push(line)
          })
          child.on('error', (error) => {
            cleanup()
            settle(() => reject(new Error(`Failed to run fd: ${error.message}`)))
          })
          child.on('close', (code) => {
            cleanup()
            if (signal?.aborted) {
              settle(() => reject(new Error('Operation aborted')))
              return
            }
            const output = lines.join('\n')
            if (code !== 0) {
              const errorMsg = stderr.trim() || `fd exited with code ${code}`
              if (!output) {
                settle(() => reject(new Error(errorMsg)))
                return
              }
            }
            if (!output) {
              settle(() => resolve({ content: [{ type: 'text', text: 'No files found matching pattern' }], details: undefined }))
              return
            }
            const relativized: string[] = []
            for (const rawLine of lines) {
              const line = rawLine.replace(/\r$/, '').trim()
              if (!line) continue
              const hadTrailingSlash = line.endsWith('/') || line.endsWith('\\')
              let relativePath = line
              if (line.startsWith(searchPath)) relativePath = line.slice(searchPath.length + 1)
              else relativePath = path.relative(searchPath, line)
              if (hadTrailingSlash && !relativePath.endsWith('/')) relativePath += '/'
              relativized.push(toPosixPath(relativePath))
            }
            const resultLimitReached = relativized.length >= effectiveLimit
            const rawOutput = relativized.join('\n')
            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })
            let resultOutput = truncation.content
            const details: FindToolDetails = {}
            const notices: string[] = []
            if (resultLimitReached) {
              notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`)
              details.resultLimitReached = effectiveLimit
            }
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
              details.truncation = truncation
            }
            if (notices.length > 0) resultOutput += `\n\n[${notices.join('. ')}]`
            settle(() => resolve({
              content: [{ type: 'text', text: resultOutput }],
              details: Object.keys(details).length > 0 ? details : undefined,
            }))
          })
        } catch (e) {
          if (signal?.aborted) {
            settle(() => reject(new Error('Operation aborted')))
            return
          }
          const error = e instanceof Error ? e : new Error(String(e))
          settle(() => reject(error))
        }
      })()
    })
  }
}

/** pi's grep and find definitions with TurboLLM's tethered `execute`. */
export function createSearchToolDefinitions(cwd: string, deps: SearchToolDeps = {}): { grep: GrepDefinition; find: FindDefinition } {
  const grep = createGrepToolDefinition(cwd)
  const find = createFindToolDefinition(cwd)
  return { grep: { ...grep, execute: grepExecute(cwd, deps) }, find: { ...find, execute: findExecute(cwd, deps) } }
}

/** The search tools to register as customTools for a session whose tool allowlist is `allowedTools` (toolsForMode):
 *  only the ones it names. With no allowlist (auto and ask mode) none, as pi would activate them all (see the
 *  header): grep and find are not in those modes' tool set. */
export function searchToolsFor(cwd: string, allowedTools: readonly string[] | undefined): ToolDefinition[] {
  if (!allowedTools) return []
  const { grep, find } = createSearchToolDefinitions(cwd)
  // Widened to the plain ToolDefinition customTools takes, as sequentialWriteTools does.
  return ([grep, find] as unknown as ToolDefinition[]).filter((t) => allowedTools.includes(t.name))
}
