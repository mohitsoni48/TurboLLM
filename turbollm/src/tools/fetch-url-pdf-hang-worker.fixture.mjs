// Test-only worker for fetch-url-pdf.test.ts: accepts its job and then never answers, so the
// parent's watchdog and slot accounting can be exercised with no dependence on how long a real
// parse takes. It stays alive until the parent terminates it.
import { parentPort } from 'node:worker_threads'
if (!parentPort) throw new Error('must run as a worker')
// A pending timeout keeps the event loop alive; no setInterval, so the daemon-tick audit
// (util/daemon-ticks.test.ts) does not see a recurring tick in a test fixture.
setTimeout(() => {}, 2_147_483_647)
