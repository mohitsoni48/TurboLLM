// window-guards.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

const { allowPermission, appOriginFor, daemonPortFor, isAppUrl, isWebUrl, launchPortFor, recordedPortFor } = require('./window-guards')

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

// The app passes its port as `--port`, which wins over the port saved in Settings: every launch put the daemon back
// on 6996 while Settings showed the saved port.
test('launchPortFor: TURBOLLM_PORT, else the port saved in Settings, else 6996', () => {
  const saved = JSON.stringify({ daemon: { host: '127.0.0.1', port: 7001 } })
  assert.equal(launchPortFor('7100', saved), '7100', 'an explicit TURBOLLM_PORT wins')
  assert.equal(launchPortFor(undefined, saved), '7001')
  assert.equal(launchPortFor('', saved), '7001')
  assert.equal(launchPortFor(undefined, ''), '6996', 'no config.json yet')
  for (const config of ['{', 'null', '{}', '{"daemon":{}}', '{"daemon":{"port":"7001"}}', '{"daemon":{"port":0}}', '{"daemon":{"port":70000}}', '{"daemon":{"port":7001.5}}']) {
    assert.equal(launchPortFor(undefined, config), '6996', config)
  }
})

test('recordedPortFor: the port the running daemon recorded in its pidfile, only from its own', () => {
  assert.equal(recordedPortFor(JSON.stringify({ pid: 42, port: 7001, host: '127.0.0.1' }), 42), '7001')
  assert.equal(recordedPortFor(JSON.stringify({ pid: 41, port: 7001 }), 42), null, 'another daemon\'s (a CLI one left it)')
  assert.equal(recordedPortFor('', 42), null, 'none yet')
  assert.equal(recordedPortFor('{"pid":42', 42), null)
  assert.equal(recordedPortFor(JSON.stringify({ pid: 42, port: 0 }), 42), null)
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
// daemon or window is started), to check how it wires the daemon's port to the window's, and what
// closing, reopening and quitting do. healthz 'ok': /healthz answers at once, so main.js opens its
// window; 'held': it answers only on answerHealthz(). Dialogs are recorded and answered by the test.
// main.js reads process.platform when it is called: run a test under another one with withPlatform.
// userData: the folder app.getPath('userData') names (the tray notice's file goes there); by default
// a fresh one, removed after the tests. home: the home folder, whose .turbollm holds the daemon's config.json and
// pidfile; by default a fresh one. env: TURBOLLM_PORT, when the test sets it (by default it is unset).
// statusNotifier: what the session bus says on Linux of a StatusNotifierWatcher, the host of tray icons: 'running'
// (by default), 'none' (GNOME without the AppIndicator extension), or 'no-bus' (no probe answers); setStatusNotifier
// changes it, and `probes` lists the probes run, with the bus address each was given.
const userDataDirs = []
// The session bus main.js's tray probe asks (window-lifecycle.js sessionBusAddress): with none, it runs no probe.
const SESSION_BUS = 'unix:path=/run/user/1000/bus'
process.env.DBUS_SESSION_BUS_ADDRESS = SESSION_BUS
test.after(() => { for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true }) })

function loadMain ({ healthz = 'ok', userData = scratchUserData(), home = scratchUserData(), env = {}, statusNotifier = 'running' } = {}) {
  const spawned = []
  const dialogs = []
  const heldHealthz = []
  const windows = []
  const trays = []
  const notifications = []
  const iconPaths = []
  const probes = []
  const appHandlers = {}
  let quits = 0
  let windowUrl = ''
  let ready = null
  class FakeWindow {
    constructor () {
      this.webContents = { setWindowOpenHandler () {}, on () {}, openDevTools () {}, getURL: () => windowUrl }
      this.url = ''
      this.destroyed = false
      this.visible = true
      this.minimized = false
      this.focused = 0
      this.handlers = {}
      windows.push(this)
    }

    loadURL (url) { windowUrl = url; this.url = url }
    isDestroyed () { return this.destroyed }
    on (event, handler) { this.handlers[event] = handler }
    hide () { this.visible = false }
    minimize () { this.minimized = true }
    show () { this.visible = true }
    focus () { this.focused += 1 }
    isMinimized () { return this.minimized }
    restore () { this.minimized = false }
    // What Electron does on the title bar's X, Alt+F4 or a quit: emit 'close', and destroy the
    // window unless a handler prevented it. 'hidden' or 'closed'.
    close () {
      let prevented = false
      if (this.handlers.close) this.handlers.close({ preventDefault () { prevented = true } })
      if (!prevented) this.destroyed = true
      return prevented ? 'hidden' : 'closed'
    }

    static getAllWindows () { return windows.filter((w) => !w.destroyed) }
  }
  class FakeTray {
    constructor (image) {
      this.image = image
      this.handlers = {}
      this.balloons = []
      trays.push(this)
    }

    setToolTip (text) { this.toolTip = text }
    setContextMenu (menu) { this.menu = menu }
    on (event, handler) { this.handlers[event] = handler }
    displayBalloon (options) { this.balloons.push(options) }
    // The tray menu item labelled `label`, clicked.
    clickItem (label) { this.menu.find((item) => item.label === label).click() }
  }
  class FakeNotification {
    constructor (options) { this.options = options }
    show () { notifications.push(this.options) }
    static isSupported () { return true }
  }
  const fakeImage = () => ({ isEmpty: () => false, resize: () => fakeImage(), addRepresentation () {}, toPNG: () => Buffer.alloc(0) })
  const electron = {
    app: {
      isPackaged: false,
      getPath: (name) => (name === 'userData' ? userData : ''),
      on (event, handler) { appHandlers[event] = handler },
      quit () { quits += 1 },
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then (f) { ready = f } }),
    },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (template) => template },
    Notification: FakeNotification,
    Tray: FakeTray,
    dialog: {
      showMessageBox (options) {
        return new Promise((resolve) => dialogs.push({ options, answer: () => resolve({ response: 0 }) }))
      },
    },
    nativeImage: { createFromPath: (path) => { iconPaths.push(path); return fakeImage() } },
    session: { defaultSession: { setPermissionRequestHandler () {}, setPermissionCheckHandler () {} } },
    shell: { openExternal () {} },
  }
  const childProcess = {
    spawn (_node, args) {
      const child = new EventEmitter()
      const signals = []
      // stdin: the daemon's lifeline (daemon-supervisor.js daemonSpawnSpec); `stdinEnded` once Quit ended it.
      const stdin = Object.assign(new EventEmitter(), { end () { child.stdinEnded = true } })
      Object.assign(child, {
        pid: 4000 + spawned.length, stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, signals, stdinEnded: false, kill (signal) { signals.push(signal) },
      })
      spawned.push({ args, child })
      return child
    },
    execFile (command, _args, options, callback) {
      probes.push({ command, bus: (options.env || process.env).DBUS_SESSION_BUS_ADDRESS })
      const answer = { running: '(true,)\n', none: '(false,)\n' }[statusNotifier]
      setImmediate(() => (answer ? callback(null, answer, '') : callback(new Error('Cannot autolaunch D-Bus without X11 $DISPLAY'), '', '')))
    },
  }
  const http = {
    get (_url, _opts, onResponse) {
      const req = new EventEmitter()
      const answer = () => onResponse({ statusCode: 200 })
      req.end = () => (healthz === 'ok' ? setImmediate(answer) : heldHealthz.push(answer))
      return req
    },
  }
  const stubs = { electron, child_process: childProcess, http }
  const load = Module._load
  Module._load = function (request, ...rest) {
    return Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : load.call(this, request, ...rest)
  }
  const saved = { TURBOLLM_PORT: process.env.TURBOLLM_PORT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  delete process.env.TURBOLLM_PORT
  Object.assign(process.env, { HOME: home, USERPROFILE: home }, env)
  try {
    delete require.cache[require.resolve('./main')]
    require('./main')
  } finally {
    Module._load = load
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  return {
    spawned,
    dialogs,
    ready: () => ready(),
    quits: () => quits,
    answerHealthz: () => heldHealthz.splice(0).forEach((answer) => answer()),
    emit: (event, ...args) => appHandlers[event](...args),
    windows: () => FakeWindow.getAllWindows(),
    allWindows: () => windows,
    trays: () => trays,
    notifications,
    iconPaths,
    probes,
    setStatusNotifier: (answer) => { statusNotifier = answer },
    windowUrl: () => windowUrl,
    setWindowUrl: (url) => { windowUrl = url },
  }
}

function scratchUserData () {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-user-data-'))
  userDataDirs.push(dir)
  return dir
}

async function withPlatform (platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

const turns = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)) }

/** A before-quit event: `prevented` once a handler held the quit. */
function quitEvent () {
  return { prevented: false, preventDefault () { this.prevented = true } }
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

// The app passed its launch port as `--port`, which wins over the port saved in Settings, so every launch put the
// daemon back on 6996 while Settings showed the saved port.
test('main.js: the daemon starts on the port saved in Settings, and the window opens there; TURBOLLM_PORT still wins', async () => {
  const home = scratchUserData()
  mkdirSync(join(home, '.turbollm'))
  writeFileSync(join(home, '.turbollm', 'config.json'), JSON.stringify({ daemon: { port: 7001 } }))
  const main = loadMain({ home })
  main.ready()
  assert.deepEqual(portArgs(main.spawned[0].args), ['--port', '7001', '--addr', '127.0.0.1:7001'])
  await turns()
  assert.equal(main.windowUrl(), 'http://127.0.0.1:7001')

  const pinned = loadMain({ home, env: { TURBOLLM_PORT: '7100' } })
  pinned.ready()
  assert.deepEqual(portArgs(pinned.spawned[0].args), ['--port', '7100', '--addr', '127.0.0.1:7100'])
})

// On macOS a close destroys the window, and the next one loaded the launch port, which nothing listened on after a
// port change in Settings: a connection error.
test('main.js: on macOS a window opened again after a port change opens on the daemon\'s port', () => withPlatform('darwin', async () => {
  const home = scratchUserData()
  const main = loadMain({ home })
  main.ready()
  await turns()
  const daemon = main.spawned[0].child
  main.setWindowUrl('http://127.0.0.1:7001/settings') // the UI followed a port change in Settings
  assert.equal(main.windows()[0].close(), 'closed')
  main.emit('activate')
  assert.equal(main.windows()[0].url, 'http://127.0.0.1:7001')

  // A port changed while no window was open (in a browser): the daemon's pidfile says where it is now.
  assert.equal(main.windows()[0].close(), 'closed')
  mkdirSync(join(home, '.turbollm'))
  writeFileSync(join(home, '.turbollm', 'daemon.pid'), JSON.stringify({ pid: daemon.pid, port: 7002 }))
  main.emit('second-instance')
  assert.equal(main.windows()[0].url, 'http://127.0.0.1:7002')

  // A pidfile another daemon left behind says nothing about this one.
  assert.equal(main.windows()[0].close(), 'closed')
  writeFileSync(join(home, '.turbollm', 'daemon.pid'), JSON.stringify({ pid: daemon.pid + 1, port: 7003 }))
  main.emit('activate')
  assert.equal(main.windows()[0].url, 'http://127.0.0.1:7002')
}))

// A CLI daemon already on ~/.turbollm makes the daemon's start guard refuse the app's daemon. The app
// quit at once, as after a crash: it opened and vanished, and the refusal, which names the running
// daemon and how to stop it, went to a stderr no one sees. A refusal in the first 15 s after the app's
// start is retried first (the next test): here the app has been up longer than that.
test('main.js: a daemon refused because another TurboLLM holds the data dir is shown in a dialog before the app quits', async (t) => {
  const refusal = 'TurboLLM is already running for /home/u/.turbollm (pid 4242, http://127.0.0.1:7000).\n' +
    'Use that one, stop it first with `turbollm --stop`, or start this one with its own --config.\n'
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const main = loadMain({ healthz: 'held' })
  const error = console.error
  console.error = () => {} // main.js logs the loss
  try {
    main.ready()
    t.mock.timers.tick(15_000)
    const daemon = main.spawned[0].child
    daemon.exitCode = 73
    daemon.emit('exit', 73, null) // the start guard's status; its stderr can still be on the way
    const write = process.stderr.write
    process.stderr.write = () => true // main.js passes the daemon's stderr through
    try {
      daemon.stderr.emit('data', Buffer.from(refusal))
    } finally {
      process.stderr.write = write
    }
    daemon.stderr.emit('close')
    await turns()

    assert.equal(main.dialogs.length, 1, 'the refusal is shown')
    const [{ options, answer }] = main.dialogs
    assert.equal(options.type, 'error')
    assert.match(options.message, /Another TurboLLM is already using your TurboLLM data folder/)
    assert.equal(options.detail, refusal.trim(), 'the dialog names the running daemon and how to stop it')
    assert.equal(main.quits(), 0, 'the app stays until the dialog is answered')
    main.answerHealthz() // whatever answers on the port now is not this app's daemon
    await turns()
    assert.equal(main.windowUrl(), '', 'no window opens')

    answer()
    await turns()
    assert.equal(main.quits(), 1)
    assert.equal(main.spawned.length, 1, 'a refused daemon is not respawned')
  } finally {
    console.error = error
  }
})

// A relaunch right after a Quit (macOS does not wait for the daemon) finds the previous daemon still shutting down,
// which holds the data dir: the app said "TurboLLM is already running" and quit, for a TurboLLM that was going away.
test('main.js: a daemon refused for its data dir within 15 s of the app\'s start is started again each second, then shown', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  const main = loadMain({ healthz: 'held' })
  const log = console.log
  const error = console.error
  console.log = () => {} // the supervisor's "starting it again" lines
  console.error = () => {}
  try {
    main.ready()
    for (let second = 0; second < 15; second++) {
      const daemon = main.spawned.at(-1).child
      daemon.exitCode = 73
      daemon.emit('exit', 73, null)
      assert.equal(main.dialogs.length, 0, `no dialog yet (${second} s)`)
      t.mock.timers.tick(1000)
      assert.equal(main.spawned.length, second + 2, `started again after a second (${second + 1} s)`)
    }
    const last = main.spawned.at(-1).child
    last.exitCode = 73
    last.emit('exit', 73, null)
    last.stderr.emit('close')
    await turns()
    assert.equal(main.dialogs.length, 1, 'after 15 s the refusal is shown')
    assert.equal(main.spawned.length, 16)
  } finally {
    console.log = log
    console.error = error
  }
})

// A `sudo turbollm` start (macOS keeps HOME) saves the owner's config.json as root, mode 0600. The app's
// daemon then may not read it: it says whose the file is and the `sudo chown` that gives it back, and exits.
// On exit 1 the app quit at once, as after a crash: it opened and vanished, with that in a stderr no one sees.
test('main.js: a daemon that may not read or write its config file is shown in a dialog before the app quits', async () => {
  const problem = "TurboLLM cannot read or write its config file /Users/u/.turbollm/config.json (EACCES: permission denied, open '/Users/u/.turbollm/config.json').\n" +
    'It belongs to another user (uid 0; this is uid 501), as after running turbollm with sudo. Give it back to this user with:\n' +
    "  sudo chown \"$(id -un)\" '/Users/u/.turbollm/config.json'\n"
  const main = loadMain({ healthz: 'held' })
  const error = console.error
  console.error = () => {} // main.js logs the loss
  try {
    main.ready()
    const daemon = main.spawned[0].child
    daemon.exitCode = 77
    daemon.emit('exit', 77, null) // cli.ts's status for it; its stderr can still be on the way
    const write = process.stderr.write
    process.stderr.write = () => true // main.js passes the daemon's stderr through
    try {
      daemon.stderr.emit('data', Buffer.from(problem))
    } finally {
      process.stderr.write = write
    }
    daemon.stderr.emit('close')
    await turns()

    assert.equal(main.dialogs.length, 1, 'the problem is shown')
    const [{ options, answer }] = main.dialogs
    assert.equal(options.type, 'error')
    assert.equal(options.title, 'TurboLLM cannot open its settings file')
    assert.match(options.message, /cannot read or write its settings file/)
    assert.equal(options.detail, problem.trim(), 'the dialog says whose the file is and how to give it back')
    assert.equal(main.quits(), 0, 'the app stays until the dialog is answered')
    main.answerHealthz()
    await turns()
    assert.equal(main.windowUrl(), '', 'no window opens')

    answer()
    await turns()
    assert.equal(main.quits(), 1)
    assert.equal(main.spawned.length, 1, 'a refused daemon is not respawned')
  } finally {
    console.error = error
  }
})

test('main.js: a daemon that crashes still quits the app at once, with no dialog', async () => {
  const main = loadMain({ healthz: 'held' })
  const error = console.error
  console.error = () => {}
  try {
    main.ready()
    const daemon = main.spawned[0].child
    daemon.exitCode = 1
    daemon.emit('exit', 1, null)
    await turns()
    assert.equal(main.quits(), 1)
    assert.deepEqual(main.dialogs, [])
  } finally {
    console.error = error
  }
})

// macOS: a Dock click while the daemon was still starting (up to its 45 s health wait) opened a
// window on the port nothing listened on yet, which showed a connection error, and the startup
// window then opened beside it.
test('main.js: the Dock icon clicked while the daemon starts opens no window; the one window opens once it answers', async () => {
  const main = loadMain({ healthz: 'held' })
  main.ready()
  main.emit('activate')
  assert.deepEqual(main.windows(), [], 'no window before the daemon answers')

  main.answerHealthz()
  await turns()
  assert.equal(main.windows().length, 1)
  assert.equal(main.windows()[0].url, 'http://127.0.0.1:6996')
  main.emit('activate')
  assert.equal(main.windows().length, 1, 'the open window is the one window')

  // Once up, reopening a closed window works as before.
  main.windows()[0].destroyed = true
  main.emit('activate')
  assert.equal(main.windows().length, 1)
  assert.equal(main.windows()[0].url, 'http://127.0.0.1:6996')
})

// Closing the window on Windows and Linux quit the app (window-all-closed → app.quit()), and the
// quit stopped the daemon (before-quit → supervisor.stop()): every reply, Code run, download,
// build, auto-tune and routine ended with the window. The daemon is a server; the window only its
// frontend.
for (const platform of ['win32', 'linux']) {
  test(`main.js: on ${platform} closing the window hides it to the tray; the app and the daemon keep running`, () => withPlatform(platform, async () => {
    const main = loadMain()
    main.ready()
    await turns()
    const daemon = main.spawned[0].child
    const [win] = main.windows()
    assert.equal(main.trays().length, 1, 'the tray icon is there from launch')
    const [tray] = main.trays()
    assert.deepEqual(main.iconPaths, [join(__dirname, 'build', 'icon.png')])
    assert.ok(existsSync(main.iconPaths[0]), 'the dev run loads the icon from wrapper/build')

    assert.equal(win.close(), 'hidden', 'the close is cancelled')
    assert.equal(win.visible, false)
    main.emit('window-all-closed') // were the window destroyed some other way: still no quit
    assert.equal(main.quits(), 0, 'the app keeps running')
    assert.deepEqual(daemon.signals, [], 'the daemon is not stopped')

    tray.clickItem('Open TurboLLM')
    assert.equal(win.visible, true, 'the tray menu shows the same window again')
    win.close()
    tray.handlers.click()
    assert.equal(win.visible, true, 'and so does a click on the icon')
    win.close()
    win.minimized = true
    main.emit('second-instance')
    assert.equal(win.visible, true, 'and so does launching the app again')
    assert.equal(win.minimized, false, 'a minimized window is restored')
    assert.equal(win.focused, 3, 'each one focuses it')
    assert.equal(main.allWindows().length, 1, 'never a second window')
  }))
}

// GNOME without the AppIndicator extension shows no tray icon: a close hid the window where only a second launch
// found it, and the notice said to quit from a tray icon the user could not see.
for (const statusNotifier of ['none', 'no-bus']) {
  test(`main.js: on a Linux desktop that shows no tray icon (${statusNotifier}) a close minimizes the window; the notice names no tray`, () => withPlatform('linux', async () => {
    const main = loadMain({ statusNotifier })
    main.ready()
    await turns()
    const daemon = main.spawned[0].child
    const [win] = main.windows()
    assert.equal(win.close(), 'hidden', 'the close is cancelled')
    assert.equal(win.minimized, true, 'minimized')
    assert.equal(win.visible, true, 'not hidden: it stays in the window list')
    assert.deepEqual(main.notifications, [{ title: 'TurboLLM', body: 'TurboLLM is still running, minimized. Quit it from File > Quit.' }])
    assert.equal(main.quits(), 0, 'the app keeps running')
    assert.deepEqual(daemon.signals, [], 'the daemon is not stopped')

    main.emit('second-instance')
    assert.equal(win.minimized, false, 'launching the app again restores it')
    assert.equal(main.allWindows().length, 1)
  }))
}

// A tray can come or go while the app runs (the AppIndicator extension turned on or off). The launch's answer was
// kept for good: each close now asks the session bus again, and the next close follows the answer.
test('main.js: on Linux each close asks the session bus again, so the next close follows a tray that came or went', () => withPlatform('linux', async () => {
  const main = loadMain({ statusNotifier: 'none' })
  main.ready()
  await turns()
  const [win] = main.windows()
  assert.deepEqual(main.probes, [{ command: 'gdbus', bus: SESSION_BUS }], 'asked at launch, on the session bus')

  main.setStatusNotifier('running') // the tray comes
  win.close()
  assert.equal(win.minimized, true, 'the answer at hand: no tray')
  await turns()
  main.emit('second-instance')
  main.setStatusNotifier('none') // and goes
  win.close()
  assert.deepEqual([win.minimized, win.visible], [false, false], 'hidden under the tray that came')

  await turns()
  main.emit('second-instance')
  assert.equal(win.visible, true)
  win.close()
  assert.deepEqual([win.minimized, win.visible], [true, true], 'minimized once the tray went')
  await turns()
  assert.equal(main.probes.length, 4, 'once at launch and once at each close')
  assert.equal(main.allWindows().length, 1)
}))

// A quit closes the windows, and a close that hides the window instead cancels the quit, so Quit
// would only hide the window and leave the daemon running. Nor may anything open a window while
// the quit closes them.
test('main.js: Quit in the tray stops the daemon, and nothing re-hides or reopens a window during the quit', () => withPlatform('win32', async () => {
  const main = loadMain()
  main.ready()
  await turns()
  const daemon = main.spawned[0].child
  const [win] = main.windows()
  const [tray] = main.trays()
  assert.deepEqual(tray.menu.map((item) => item.label || item.type), ['Open TurboLLM', 'separator', 'Quit TurboLLM'])

  tray.clickItem('Quit TurboLLM')
  assert.equal(main.quits(), 1)
  main.emit('before-quit', quitEvent()) // what Electron's app.quit() emits first, before it closes the windows
  assert.equal(daemon.stdinEnded, true, 'the daemon is stopped, gracefully: its stdin lifeline ends')
  assert.equal(win.close(), 'closed', 'the window closes, so the quit goes on')
  assert.deepEqual(tray.balloons, [], 'no "still running" notice for a quit')

  tray.clickItem('Open TurboLLM')
  tray.handlers.click()
  main.emit('second-instance')
  assert.equal(main.allWindows().length, 1, 'no window opens during the quit')
  assert.deepEqual(main.windows(), [])
}))

test('main.js: a quit while the daemon starts opens no window when it answers', () => withPlatform('linux', async () => {
  const main = loadMain({ healthz: 'held' })
  main.ready()
  main.emit('before-quit', quitEvent())
  main.answerHealthz()
  await turns()
  assert.deepEqual(main.allWindows(), [])
}))

test('main.js: the first close to the tray shows one notice, remembered in userData across launches', async () => {
  const userData = scratchUserData()
  await withPlatform('win32', async () => {
    const main = loadMain({ userData })
    main.ready()
    await turns()
    const [win] = main.windows()
    const [tray] = main.trays()
    win.close()
    main.emit('second-instance')
    win.close()
    assert.deepEqual(tray.balloons, [{ title: 'TurboLLM', content: 'TurboLLM is still running. Quit it from the tray icon.' }])
    assert.deepEqual(JSON.parse(readFileSync(join(userData, 'tray-notice.json'), 'utf8')), { shown: true })
  })
  await withPlatform('linux', async () => {
    const main = loadMain({ userData }) // the next launch: the notice was shown already
    main.ready()
    await turns()
    main.windows()[0].close()
    assert.deepEqual(main.notifications, [])
  })
  rmSync(join(userData, 'tray-notice.json'))
  await withPlatform('linux', async () => {
    const main = loadMain({ userData })
    main.ready()
    await turns()
    main.windows()[0].close()
    main.windows()[0].close()
    assert.deepEqual(main.notifications, [{ title: 'TurboLLM', body: 'TurboLLM is still running. Quit it from the tray icon.' }],
      'on Linux a desktop notification, once')
  })
})

// macOS keeps its Dock: no tray icon, a close closes the window and the app stays. A second launch
// that starts a second process (from a terminal, or open -n) then returned without opening anything
// (second-instance only showed a window that still existed); one from the Finder or the Dock reuses
// the running app (activate) and already opened one.
test('main.js: on macOS a close keeps the app in the Dock, and a second launch or the Dock opens a new window', () => withPlatform('darwin', async () => {
  const main = loadMain()
  main.ready()
  await turns()
  assert.deepEqual(main.trays(), [], 'no tray icon on macOS')
  const daemon = main.spawned[0].child
  assert.equal(main.windows()[0].close(), 'closed')
  main.emit('window-all-closed')
  assert.equal(main.quits(), 0)
  assert.deepEqual(daemon.signals, [])
  assert.deepEqual(main.notifications, [])

  main.emit('second-instance')
  assert.equal(main.windows().length, 1, 'a second launch opens a window again')
  assert.equal(main.windows()[0].url, 'http://127.0.0.1:6996')
  main.emit('activate')
  main.emit('second-instance')
  assert.equal(main.windows().length, 1, 'the open window is shown, not duplicated')
}))

// Quit stopped the daemon with kill('SIGTERM'), a TerminateProcess on Windows: no teardown ran there (replies not
// saved as stopped, the store not closed, an engine's tree cut loose), and Electron's exit took the daemon through
// its job object anyway. On Linux the AppImage's mount went away with Electron, under a daemon still shutting down.
// Now Quit ends the daemon's stdin and holds the quit until the daemon has exited.
for (const platform of ['win32', 'linux']) {
  test(`main.js: on ${platform} Quit holds the quit until the daemon has shut down by itself, then quits`, () => withPlatform(platform, async () => {
    const main = loadMain()
    main.ready()
    await turns()
    const daemon = main.spawned[0].child
    const first = quitEvent()
    main.emit('before-quit', first)
    assert.equal(first.prevented, true, 'the quit waits')
    assert.equal(daemon.stdinEnded, true, 'the daemon\'s stdin lifeline ends: its own graceful shutdown runs')
    assert.deepEqual(daemon.signals, [], 'no signal: on Windows any kill is a TerminateProcess')
    const again = quitEvent()
    main.emit('before-quit', again) // another Quit meanwhile
    assert.equal(again.prevented, true)
    assert.equal(main.quits(), 0)

    daemon.exitCode = 0
    daemon.emit('exit', 0, null)
    await turns()
    assert.equal(main.quits(), 1, 'the app quits once the daemon has exited')
    const last = quitEvent()
    main.emit('before-quit', last)
    assert.equal(last.prevented, false, 'and that quit goes through')
    assert.equal(main.spawned.length, 1, 'nothing respawned')
  }))
}

// A quit prevented during a macOS logout or shutdown cancels the logout. The daemon finishes by itself from the
// .app on disk (its watcher caps that at 15 s).
test('main.js: on macOS Quit never holds the quit; it only ends the daemon\'s stdin', () => withPlatform('darwin', async () => {
  const main = loadMain()
  main.ready()
  await turns()
  const daemon = main.spawned[0].child
  const event = quitEvent()
  main.emit('before-quit', event)
  assert.equal(event.prevented, false, 'a logout is not cancelled')
  assert.equal(daemon.stdinEnded, true)
  assert.deepEqual(daemon.signals, [])
}))
