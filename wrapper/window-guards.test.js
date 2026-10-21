// window-guards.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
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
// daemon or window is started), to check how it wires the daemon's port to the window's, and what
// closing, reopening and quitting do. healthz 'ok': /healthz answers at once, so main.js opens its
// window; 'held': it answers only on answerHealthz(). Dialogs are recorded and answered by the test.
// main.js reads process.platform when it is called: run a test under another one with withPlatform.
// userData: the folder app.getPath('userData') names (the tray notice's file goes there); by default
// a fresh one, removed after the tests.
const userDataDirs = []
test.after(() => { for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true }) })

function loadMain ({ healthz = 'ok', userData = scratchUserData() } = {}) {
  const spawned = []
  const dialogs = []
  const heldHealthz = []
  const windows = []
  const trays = []
  const notifications = []
  const iconPaths = []
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
      Object.assign(child, {
        stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, signals, kill (signal) { signals.push(signal) },
      })
      spawned.push({ args, child })
      return child
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
  const port = process.env.TURBOLLM_PORT
  delete process.env.TURBOLLM_PORT
  try {
    delete require.cache[require.resolve('./main')]
    require('./main')
  } finally {
    Module._load = load
    if (port !== undefined) process.env.TURBOLLM_PORT = port
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

// A CLI daemon already on ~/.turbollm makes the daemon's start guard refuse the app's daemon. The app
// quit at once, as after a crash: it opened and vanished, and the refusal, which names the running
// daemon and how to stop it, went to a stderr no one sees.
test('main.js: a daemon refused because another TurboLLM holds the data dir is shown in a dialog before the app quits', async () => {
  const refusal = 'TurboLLM is already running for /home/u/.turbollm (pid 4242, http://127.0.0.1:7000).\n' +
    'Use that one, stop it first with `turbollm --stop`, or start this one with its own --config.\n'
  const main = loadMain({ healthz: 'held' })
  const error = console.error
  console.error = () => {} // main.js logs the loss
  try {
    main.ready()
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
  main.emit('before-quit') // what Electron's app.quit() emits first, before it closes the windows
  assert.deepEqual(daemon.signals, ['SIGTERM'], 'the daemon is stopped as before')
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
  main.emit('before-quit')
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
