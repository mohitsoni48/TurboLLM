// Test-only worker for fetch-url-pdf.test.ts: accepts its job and then never answers, so the
// parent's watchdog and slot accounting can be exercised with no dependence on how long a real
// parse takes. It stays alive until the parent terminates it.
import { parentPort } from 'node:worker_threads'
if (!parentPort) throw new Error('must run as a worker')
setInterval(() => {}, 1_000)
