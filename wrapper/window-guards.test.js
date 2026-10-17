// window-guards.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

const { allowPermission, appOriginFor, daemonPortFor, isAppUrl, isWebUrl } = require('./window-guards')

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

test('daemonPortFor: a spawned daemon binds the port of the app page the window shows, else the launch port', () => {
  assert.equal(daemonPortFor('', APP, 6996), '6996', 'no window yet: the first launch')
  assert.equal(daemonPortFor('http://127.0.0.1:6996/chat/42', APP, 6996), '6996')
  // After a port change in Settings the daemon and then the window are on the new port.
  assert.equal(daemonPortFor('http://127.0.0.1:7001/settings', APP, 6996), '7001')

  assert.equal(daemonPortFor('about:blank', APP, 6996), '6996')
  assert.equal(daemonPortFor('https://evil.example:7001/', APP, 6996), '6996')
  assert.equal(daemonPortFor('http://localhost:7001/', APP, 6996), '6996')
  assert.equal(daemonPortFor('http://127.0.0.1/', APP, '7002'), '7002', 'no explicit port: keep the launch port')
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

// Runs the real main.js against a stand-in for electron (and for child_process and http, so no
// daemon or window is started), to check how it wires the daemon's port to the window's.
function loadMain () {
  const spawned = []
  let windowUrl = ''
  let ready = null
  class FakeWindow {
    constructor () {
      this.webContents = { setWindowOpenHandler () {}, on () {}, openDevTools () {}, getURL: () => windowUrl }
    }

    loadURL (url) { windowUrl = url }
    isDestroyed () { return false }
    static getAllWindows () { return [] }
  }
  const electron = {
    app: {
      isPackaged: false,
      on () {},
      quit () {},
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then (f) { ready = f } }),
    },
    BrowserWindow: FakeWindow,
    session: { defaultSession: { setPermissionRequestHandler () {}, setPermissionCheckHandler () {} } },
    shell: { openExternal () {} },
  }
  const childProcess = {
    spawn (_node, args) {
      const child = new EventEmitter()
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill () {} })
      spawned.push({ args, child })
      return child
    },
  }
  // /healthz answers at once, so main.js opens its window.
  const http = {
    get (_url, _opts, onResponse) {
      const req = new EventEmitter()
      req.end = () => setImmediate(() => onResponse({ statusCode: 200 }))
      return req
    },
  }
  const stubs = { electron, child_process: childProcess, http }
  const load = Module._load
  Module._load = function (request, ...rest) {
    return Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : load.call(this, request, ...rest)
  }
  const port = process.env.TURBOLLM_PORT
  delete process.env.TURBOLLM_PORT
  try {
    delete require.cache[require.resolve('./main')]
    require('./main')
  } finally {
    Module._load = load
    if (port !== undefined) process.env.TURBOLLM_PORT = port
  }
  return { spawned, ready: () => ready(), windowUrl: () => windowUrl, setWindowUrl: (url) => { windowUrl = url } }
}

const portArgs = (args) => args.slice(args.indexOf('--port'), args.indexOf('--port') + 4)

// A port change in Settings moves the live daemon and then the window. The daemon's --port is read
// only at boot, so a respawn on the launch port left the window (and the restart overlay polling its
// own origin) on a port nothing listened on.
test('main.js: a respawn after a requested restart binds the port the window is on now', async () => {
  const main = loadMain()
  const log = console.log
  console.log = () => {} // the supervisor's "restarting" line
  try {
    main.ready()
    assert.equal(main.spawned.length, 1)
    assert.deepEqual(portArgs(main.spawned[0].args), ['--port', '6996', '--addr', '127.0.0.1:6996'])
    await new Promise((resolve) => setImmediate(resolve)) // /healthz answers; the window opens
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(main.windowUrl(), 'http://127.0.0.1:6996')

    main.setWindowUrl('http://127.0.0.1:7001/settings') // the UI followed a port change
    main.spawned[0].child.exitCode = 75
    main.spawned[0].child.emit('exit', 75, null) // the daemon asks for a restart
    assert.equal(main.spawned.length, 2)
    assert.deepEqual(portArgs(main.spawned[1].args), ['--port', '7001', '--addr', '127.0.0.1:7001'])
    assert.ok(main.spawned[1].args.includes('--no-open'))
  } finally {
    console.log = log
  }
})
