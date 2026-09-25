import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** A scratch root older than this is abandoned even if its pid is running: pids get reused
 *  (Windows does it aggressively), so "the owner is alive" alone can't be trusted. */
export const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000

export interface SweepOptions {
  isAlive?: (pid: number) => boolean
  now?: () => number
}

const ROOT_NAME = /^(\d+)-(\d+)-/

/** A directory owned by one test process; every temp dir that process needs lives inside it,
 *  so it can be removed with a single call. The name records the owner's pid and start time. */
export function createScratchRoot(base: string): string {
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, `${process.pid}-${Date.now()}-`))
}

/** Never throws: failing to clean up must not fail a test. An unremovable root (an open file
 *  handle on Windows, say) is left for the next run's sweep; `owner` names who left it there. */
export function removeScratchRoot(root: string, owner = 'another test process'): boolean {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    return true
  } catch (err) {
    console.warn(`could not remove test scratch root ${root} left by ${owner} (${(err as Error).message}); the next test run will sweep it`)
    return false
  }
}

/** Removes the roots of processes that can no longer clean up after themselves (killed,
 *  timed out, crashed hard). Returns the roots it removed. */
export function sweepAbandonedRoots(base: string, options: SweepOptions = {}): string[] {
  const { isAlive = processIsAlive, now = Date.now } = options
  const swept: string[] = []
  for (const name of listDirectoryNames(base)) {
    const root = join(base, name)
    if (isAbandoned(name, isAlive, now()) && removeScratchRoot(root)) swept.push(root)
  }
  return swept
}

function isAbandoned(name: string, isAlive: (pid: number) => boolean, nowMs: number): boolean {
  const match = ROOT_NAME.exec(name)
  if (!match) return false
  const [, pid, createdAtMs] = match
  return nowMs - Number(createdAtMs) > ABANDONED_AFTER_MS || !isAlive(Number(pid))
}

function listDirectoryNames(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
