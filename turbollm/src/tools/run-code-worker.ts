// Entry point for the `run_code` worker thread — see execRunCode in builtin.ts for why this runs
// in a dedicated node:worker_threads Worker rather than on the daemon's main thread, and
// run-code-sandbox.ts for the vm-realm-escape invariant this must not violate. This file is
// intentionally tiny: read the code string out of workerData, run it, post the result string
// back. No other logic belongs here — anything more would be one more thing to keep off the
// caller's realm.
import { parentPort, workerData } from 'node:worker_threads'

// A plain `import './run-code-sandbox.js'` relies on tsx's loader remapping that `.js` specifier
// to the sibling `.ts` source in dev/test — but a freshly spawned worker_threads Worker doesn't
// reliably inherit that loader hook for its OWN nested imports (confirmed live: this failed with
// "Cannot find module '.../run-code-sandbox.js'" on Linux CI while passing on Windows dev, even
// though this very file — also raw `.ts` — loaded fine as the worker's entry point either way).
// Fixed the same way builtin.ts already resolves THIS file's own path (see WORKER_PATH there):
// compute the sibling module's real extension from this file's own `import.meta.url` (`.ts` under
// tsx, `.js` once built — see tsup.config.ts, where run-code-sandbox is its own build entry for
// exactly this) and dynamically import an absolute same-directory URL, so resolution never depends
// on any loader hook being active in this thread — only on a real file existing next to this one,
// which is true in both dev and the built package.
const SANDBOX_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const SANDBOX_URL = new URL(`./run-code-sandbox${SANDBOX_EXT}`, import.meta.url)
const { runCodeInSandbox } = await import(SANDBOX_URL.href)

if (!parentPort) {
  throw new Error('run-code-worker.ts must be run as a worker_threads Worker, not imported directly.')
}

const code = String((workerData as { code?: unknown } | undefined)?.code ?? '')
parentPort.postMessage(runCodeInSandbox(code))
