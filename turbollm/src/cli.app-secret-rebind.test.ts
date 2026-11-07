// Source-level guard for TurboLLM-Android's app secret across an in-place rebind (boot.ts listen()).
//
// Why a source scan: the case is a port another app takes during the rebind, after which the daemon calls
// process.exit, which a test daemon in the test's own process cannot reach (cli.rebind.test.ts runs this code with
// exit recorded, for the cases it can stage). A LAN toggle closes the listener and binds again on the same port;
// in between, another app on the phone can take 127.0.0.1:<port> and collect the app's secret from
// the WebView's next requests, then let go so the daemon's bind retry succeeds and the stolen secret
// works. A same-process rebind is never refused on Linux (close() releases the port at once), so on
// the app a busy port during a rebind can only mean that, and the daemon must stop, not retry.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { daemonSourceInBootOrder } from './test-support/daemon-source'

// cli.ts with bootDaemon's body (boot.ts) in place of its call: the daemon's source in the order it runs.
const CLI = daemonSourceInBootOrder()

function listenBlock(): string {
  const start = CLI.indexOf('function listen(attempt = 0): void {')
  assert.ok(start >= 0, 'cli.ts must define listen()')
  const end = CLI.indexOf('\n}\n', start)
  return CLI.slice(start, end + 2)
}

test('with the app secret set, a port taken during a same-port rebind or its revert stops the daemon instead of retrying', () => {
  const listen = listenBlock()
  // Same port only: a port change (API-only on the app) moves to a port the app never sends to, so a
  // busy new port keeps its retry and revert, and the revert to the old port is then checked here.
  const guard = listen.indexOf("if (e?.code === 'EADDRINUSE' && (rebinding || reverting) && port === prevPort && process.env.TURBOLLM_APP_SECRET) {")
  assert.ok(guard >= 0, 'the error handler must check for a port taken during a rebind on the app')
  const retry = listen.indexOf("if (e?.code === 'EADDRINUSE' && attempt < 20) {")
  assert.ok(retry > guard, 'the check must come before the bind retry, which would wait for the other app to let go')
  const body = listen.slice(guard, retry)
  assert.ok(body.includes('process.exit(1)'), 'it must stop the daemon (and with it the app process and the secret)')
})

test('the boot-time bind retry is unchanged: the app asks for a proof before it sends the secret then', () => {
  // Before the first bind nothing has been sent yet: the app's DaemonAuth withholds the secret until
  // the daemon answers GET /api/v1/app-proof, so a busy port at boot is still retried as before.
  const listen = listenBlock()
  // (The next try's count starts over when a rebind re-pointed the bind meanwhile; see cli.ts.)
  assert.match(listen, /if \(e\?\.code === 'EADDRINUSE' && attempt < 20\) \{\n {8}if \(attempt === 0\) console\.log\(` {2}Port \$\{port\} busy \(previous listener releasing\) — retrying…`\)\n(?: {8}\/\/.*\n)* {8}setTimeout\(\(\) => listen\(`\$\{host\}:\$\{port\}` === tried \? attempt \+ 1 : 0\), 500\)/)
})
