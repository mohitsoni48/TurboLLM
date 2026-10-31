// How the Manager reaches an engine (architecture §6.3): its URL, the headers its requests carry, and how it is stopped.
// The Manager's state machine (manager.ts) drives an engine through this seam, so an engine the daemon does not spawn
// (D-6's in-app SDK engine) can sit behind it. SpawnedTransport is the engine process the daemon spawned: the stop and
// kill code below is manager.ts's, moved unchanged. Spawning, the pidfile, the tether, the engine log, the reaper and
// the idle watchdog stay in manager.ts, on the spawned path only.
import { type ChildProcess, execFile } from 'node:child_process'
import { killTetheredTree } from '../util/tether'

export interface EngineTransport {
  /** The engine's base URL, without a trailing slash. */
  target(): string
  /** Headers of the engine's own that every request to it carries. */
  headers(): Record<string, string>
  /** Asks the engine to stop, forcing it after the grace; resolves once it has gone. */
  stop(): Promise<void>
  /** Ends the engine now, without the grace. */
  kill(): void
}

/** An engine process the daemon spawned and owns, listening on its own loopback port. `exited` resolves at the
 *  process's 'close'. */
export class SpawnedTransport implements EngineTransport {
  constructor(
    private readonly child: ChildProcess,
    private readonly port: number,
    private readonly exited: Promise<void>,
  ) {}

  target(): string {
    return `http://127.0.0.1:${this.port}`
  }

  headers(): Record<string, string> {
    return {}
  }

  stop(): Promise<void> {
    return gracefulStop(this.child, this.exited)
  }

  kill(): void {
    forceKill(this.child)
  }
}

async function gracefulStop(child: ChildProcess, exited: Promise<void>): Promise<void> {
  signalTerm(child)
  const result = await exitedWithin(exited, 8000)
  if (result === 'timeout') {
    forceKill(child)
    await exited
  }
}

/** 'exited' once `exited` resolves, or 'timeout' after `ms`. The timer is cleared once the race is decided: a bare
 *  sleep() left its ref'd timer running after a prompt exit, which held the event loop (a test file, a CLI run) open
 *  for the rest of it. A prompt exit left two per stopAndWait(): gracefulStop's 8 s grace and waitForExit's 10 s. */
export async function exitedWithin(exited: Promise<void>, ms: number): Promise<'exited' | 'timeout'> {
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => { grace = setTimeout(() => resolve('timeout'), ms) }),
    ])
  } finally {
    clearTimeout(grace)
  }
}

function signalTerm(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // Force the tree at once. A plain `taskkill /PID <pid> /T` (no /F) only posts WM_CLOSE to the process's windows,
    // and the engines are console programs with none (spawned windowsHide with piped stdio), so Windows refuses it
    // ("This process can only be terminated forcefully (with /F option)") and every Stop, model swap, pool eviction
    // and update stop sat out the whole 8 s grace in 'stopping', with every load queued behind the gate waiting too,
    // before forceKill ended it anyway. llama-server, KoboldCpp and llamafile exit cleanly only on a console
    // Ctrl+C, which taskkill never sends, so there is no gentler request to make from here.
    forceKill(child)
  } else {
    child.kill('SIGTERM')
  }
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // Not once Node has seen the engine exit (a worker holding its stdout keeps 'close', and so the stop, waiting):
    // libuv has closed the process handle that kept the pid from being reused, so `/PID <pid> /T` may name another
    // process tree by then, as in killTetheredTree (util/tether.ts). An exited root is no tree for taskkill anyway.
    if (child.exitCode !== null || child.signalCode !== null) return
    execFile('taskkill', ['/PID', String(child.pid), '/F', '/T'], () => {})
  } else {
    // The engine's whole group (its workers too); the pid alone when it leads none (the Android helper).
    killTetheredTree(child, 'SIGKILL')
  }
}
