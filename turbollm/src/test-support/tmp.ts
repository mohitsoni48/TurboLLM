// The one way a test gets a temp directory. Never call mkdtemp/tmpdir in a test file: a
// forgotten cleanup there leaks into the shared temp folder on every run (the raw-tmp guard
// test enforces this).
//
// Every directory a test process asks for lives inside ONE scratch root, which is deleted when
// that file's tests finish (and again on process exit). A process that dies without warning
// (killed, timed out) leaves its root behind; the next process to start sweeps it away.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { createScratchRoot, removeScratchRoot, sweepAbandonedRoots } from './scratch-roots'

const SCRATCH_BASE_NAME = 'turbollm-tests'

let ownRoot: string | null = null

/** A fresh, empty directory that is removed automatically. Open handles inside it (a SQLite
 *  file, a running child's cwd) block removal on Windows, so close them at the end of the test. */
export function tmpDir(prefix: string): string {
  return mkdtempSync(join(ownScratchRoot(), prefix))
}

export function releaseTmpDirs(): void {
  if (ownRoot === null) return
  removeScratchRoot(ownRoot, process.argv[1])
  ownRoot = null
}

function ownScratchRoot(): string {
  if (ownRoot === null) {
    const base = join(tmpdir(), SCRATCH_BASE_NAME)
    sweepAbandonedRoots(base)
    ownRoot = createScratchRoot(base)
  }
  return ownRoot
}

after(releaseTmpDirs)
process.once('exit', releaseTmpDirs)
