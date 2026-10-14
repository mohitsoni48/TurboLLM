// window-guards.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const { allowPermission, appOriginFor, isAppUrl, isWebUrl } = require('./window-guards')

const APP = appOriginFor(6996)

test('the app origin is the loopback address main.js loads', () => {
  assert.equal(APP, 'http://127.0.0.1:6996')
  assert.equal(appOriginFor('7001'), 'http://127.0.0.1:7001')
})

test('isAppUrl: only the app host stays in the window', () => {
  assert.equal(isAppUrl('http://127.0.0.1:6996/', APP), true)
  assert.equal(isAppUrl('http://127.0.0.1:6996/chat/42?x=1#y', APP), true)
  // A port change in Settings sends the window to the daemon's new port (SettingsScreen.tsx).
  assert.equal(isAppUrl('http://127.0.0.1:7001/', APP), true, 'the post-port-change hop stays in the window')

  assert.equal(isAppUrl('https://evil.example/login', APP), false)
  assert.equal(isAppUrl('http://localhost:6996/', APP), false)
  assert.equal(isAppUrl('http://127.0.0.1.evil.example:6996/', APP), false)
  assert.equal(isAppUrl('https://127.0.0.1:6996/', APP), false)
  assert.equal(isAppUrl('file:///etc/passwd', APP), false)
  assert.equal(isAppUrl('not a url', APP), false)
  assert.equal(isAppUrl(undefined, APP), false)
})

test('isWebUrl: only http(s) is handed to the system browser', () => {
  assert.equal(isWebUrl('https://huggingface.co/org/model'), true)
  assert.equal(isWebUrl('HTTP://example.com'), true)

  assert.equal(isWebUrl('file:///C:/Windows/System32/calc.exe'), false)
  assert.equal(isWebUrl('javascript:alert(1)'), false)
  assert.equal(isWebUrl('ms-settings:privacy'), false)
  assert.equal(isWebUrl('smb://host/share'), false)
  assert.equal(isWebUrl(''), false)
})

test('allowPermission: an outside page gets nothing, not even what the app itself may use', () => {
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-sanitized-write', 'clipboard-read']) {
    assert.equal(allowPermission(permission, 'https://evil.example/', APP), false, permission)
  }
})

test('allowPermission: the app gets exactly what the web UI uses', () => {
  assert.equal(allowPermission('clipboard-sanitized-write', 'http://127.0.0.1:6996/chat', APP), true)
  assert.equal(allowPermission('notifications', 'http://127.0.0.1:6996', APP), true)

  for (const permission of ['media', 'geolocation', 'clipboard-read', 'display-capture', 'openExternal', 'unknown']) {
    assert.equal(allowPermission(permission, 'http://127.0.0.1:6996/', APP), false, permission)
  }
})

test('allowPermission: after a port change the app keeps exactly the same permissions, no more', () => {
  assert.equal(allowPermission('clipboard-sanitized-write', 'http://127.0.0.1:7001/chat', APP), true)
  assert.equal(allowPermission('notifications', 'http://127.0.0.1:7001', APP), true)
  for (const permission of ['media', 'geolocation', 'clipboard-read']) {
    assert.equal(allowPermission(permission, 'http://127.0.0.1:7001/', APP), false, permission)
  }
})

// main.js needs Electron to run, so these pin its wiring at the source level.
const mainSource = readFileSync(join(__dirname, 'main.js'), 'utf8')

test('main.js guards every window it creates', () => {
  const windows = mainSource.match(/new BrowserWindow\(/g) || []
  const guarded = mainSource.match(/guardWindow\(mainWindow\)/g) || []
  assert.ok(windows.length > 0)
  assert.equal(guarded.length, windows.length)
  assert.match(mainSource, /setPermissionRequestHandler\(/)
  assert.match(mainSource, /setPermissionCheckHandler\(/)
})

test('main.js starts the daemon with --no-open: the window is the UI, a browser tab would duplicate it', () => {
  const argv = mainSource.match(/args: \[([^\]]*)\]/)
  assert.ok(argv, 'main.js must build the daemon argv as `args: [...]`')
  assert.match(argv[1], /'--no-open'/)
})

test('main.js takes the single-instance lock before it starts a daemon', () => {
  const lock = mainSource.indexOf('app.requestSingleInstanceLock()')
  assert.ok(lock !== -1, 'a second launch must not start a second daemon on the same data dir')
  assert.ok(lock < mainSource.indexOf('supervisor.start()'))
  assert.match(mainSource, /app\.on\('second-instance'/)
})

test('main.js does not run electron-updater on macOS (no zip, unsigned: it cannot install there)', () => {
  const body = mainSource.slice(mainSource.indexOf('function setupAutoUpdate'), mainSource.indexOf("require('electron-updater')"))
  assert.match(body, /process\.platform === 'darwin'\) return/)
})
