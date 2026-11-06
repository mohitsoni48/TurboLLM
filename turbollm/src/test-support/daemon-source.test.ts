import assert from 'node:assert/strict'
import { test } from 'node:test'
import { daemonSourceInBootOrder } from './daemon-source'

test('the daemon source reads as one program in boot order: cli.ts with the bootDaemon call replaced by its body', () => {
  const src = daemonSourceInBootOrder()
  assert.ok(!src.includes('await bootDaemon('), 'the call is replaced')
  const guard = src.indexOf('const runningDaemon = await findRunningDaemon(store.dir())')
  const reap = src.indexOf('const reaped = await reapStaleEngines(store.dir())')
  const listen = src.indexOf('\nlisten()\n')
  const restart = src.indexOf('deps.requestRestart = (')
  assert.ok(guard > 0 && guard < reap && reap < listen && listen < restart, 'cli guard, boot body, then cli lifecycle')
  assert.ok(src.includes('\nfunction listen(attempt = 0): void {\n'), 'the body is dedented to column 0')
})
