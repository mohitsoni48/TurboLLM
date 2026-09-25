import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layaInstallArgs, LAYA_LAUNCHER_SOURCE, LAYA_PACKAGE, layaServerCommand } from './laya'

test('layaServerCommand runs the launcher through the venv python with the model dir, host and port as argv', () => {
  const { cmd, args } = layaServerCommand('/venv/bin/python', '/models/laya', 6997, '127.0.0.1')
  assert.equal(cmd, '/venv/bin/python')
  assert.deepEqual(args, ['-c', LAYA_LAUNCHER_SOURCE, '/models/laya', '127.0.0.1', '6997'])
})

test('the launcher never downloads: every checkpoint it serves comes from the model folder', () => {
  assert.match(LAYA_LAUNCHER_SOURCE, /router\.models\.update\(found\)/)
  assert.match(LAYA_LAUNCHER_SOURCE, /"multilingual", "typed-decisions"/)
})

test('the launcher refuses a request whose checkpoint is not in the folder instead of answering with another one', () => {
  assert.match(LAYA_LAUNCHER_SOURCE, /def on_route\(self, ctx\)/)
  assert.match(LAYA_LAUNCHER_SOURCE, /raise ValueError\(/)
})

test('the launcher binds the host it is given, not laya-serve\'s 0.0.0.0 default', () => {
  assert.match(LAYA_LAUNCHER_SOURCE, /uvicorn\.run\(create_app\(router\), host=host, port=port/)
  assert.doesNotMatch(LAYA_LAUNCHER_SOURCE, /0\.0\.0\.0/)
})

test('layaInstallArgs installs laya[serve] with the torch build that matches the GPU', () => {
  assert.deepEqual(layaInstallArgs('/venv/bin/python', false), [
    'pip', 'install', '--python', '/venv/bin/python', '--torch-backend=auto', LAYA_PACKAGE,
  ])
})

test('layaInstallArgs passes --upgrade only for an update', () => {
  assert.ok(layaInstallArgs('/py', true).includes('--upgrade'))
  assert.ok(!layaInstallArgs('/py', false).includes('--upgrade'))
})

test('LAYA_PACKAGE pins the 0.3 line the launcher is written against', () => {
  assert.equal(LAYA_PACKAGE, 'laya[serve]>=0.3.20,<0.4')
})

test('the launcher warms every preloaded checkpoint before it serves, so readiness means the first request is fast', () => {
  const warm = LAYA_LAUNCHER_SOURCE.indexOf('router.predict(')
  const serve = LAYA_LAUNCHER_SOURCE.indexOf('uvicorn.run(')
  assert.ok(warm > 0, 'no warm-up prediction')
  assert.ok(warm < serve, 'the warm-up must finish before the server binds (readiness is its /health)')
  assert.match(LAYA_LAUNCHER_SOURCE, /for name in preloaded:\n\s+router\.predict\(/)
})
