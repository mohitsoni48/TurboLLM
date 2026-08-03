// Entry point for the `run_code` worker thread — see execRunCode in builtin.ts for why this runs
// in a dedicated node:worker_threads Worker rather than on the daemon's main thread, and
// run-code-sandbox.ts for the vm-realm-escape invariant this must not violate. This file is
// intentionally tiny: read the code string out of workerData, run it, post the result string
// back. No other logic belongs here — anything more would be one more thing to keep off the
// caller's realm.
import { parentPort, workerData } from 'node:worker_threads'
import { runCodeInSandbox } from './run-code-sandbox.js'

if (!parentPort) {
  throw new Error('run-code-worker.ts must be run as a worker_threads Worker, not imported directly.')
}

const code = String((workerData as { code?: unknown } | undefined)?.code ?? '')
parentPort.postMessage(runCodeInSandbox(code))
