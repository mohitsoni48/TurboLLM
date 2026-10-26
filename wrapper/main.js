// main.js — TurboLLM Desktop native wrapper
// Spawns the TurboLLM daemon (bundled under resources/daemon/), waits for /healthz,
// then opens a native window pointed at http://localhost:6996. Closing the window leaves
// the app and its daemon running (a tray icon on Windows and Linux, the Dock on macOS);
// only quitting the app stops the daemon (window-lifecycle.js).
const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, session, shell } = require('electron')
const { join } = require('path')
const { homedir } = require('os')
const { execFile, spawn } = require('child_process')
const http = require('http')
const { existsSync, readFileSync } = require('fs')
const { createDaemonSupervisor, daemonSpawnSpec, dataDirInUseNotice, configAccessNotice } = require('./daemon-supervisor')
const { allowPermission, appOriginFor, daemonPortFor, isAppUrl, isWebUrl, launchPortFor, recordedPortFor } = require('./window-guards')
const {
  MINIMIZED_NOTICE, TRAY_ICON, TRAY_NOTICE, TRAY_NOTICE_FILE, closeAction, createTrayNotice, openAction,
  probeStatusNotifierHost, quitsWhenAllClosed, trayMenuTemplate, usesTray,
} = require('./window-lifecycle')

// The daemon's data folder, which holds its config.json and its pidfile: ~/.turbollm, as the app passes no --config.
const DATA_DIR = join(homedir(), '.turbollm')

/** A file of the daemon's data folder, or '' when it cannot be read. */
function readDataFile (name) {
  try {
    return readFileSync(join(DATA_DIR, name), 'utf8')
  } catch {
    return ''
  }
}

// TURBOLLM_PORT, else the port saved in Settings, else 6996 (window-guards.js launchPortFor).
const PORT = launchPortFor(process.env.TURBOLLM_PORT, readDataFile('config.json'))
const APP_ORIGIN = appOriginFor(PORT)

// ── Locate daemon files ───────────────────────────────────────────────────────
// The daemon depends on node-pty (native addon, used by the terminal-agent PTY
// feature) and node:sqlite. Both need to run under a REAL Node.js binary built
// for the host platform/arch — Electron's own embedded Node (via
// ELECTRON_RUN_AS_NODE) has a different ABI and would fail to load node-pty's
// prebuilt binding. So the packaged app ships an actual node(.exe) copy
// (electron-builder.config.cjs copies the CI runner's own Node binary in) and
// a real `node_modules/` (built with `npm ci` on that same platform), not just
// the bundled dist/cli.js in isolation.
function getDaemonNode () {
  if (app.isPackaged) {
    return join(process.resourcesPath, process.platform === 'win32' ? 'node.exe' : 'node')
  }
  // Dev (`npm start`): the developer running this has Node on PATH.
  return 'node'
}

function getDaemonDir () {
  if (app.isPackaged) {
    const daemonDir = join(process.resourcesPath, 'daemon')
    if (existsSync(join(daemonDir, 'bin', 'turbollm.mjs'))) return daemonDir
    return null
  }
  // Dev fallback: turbollm/ is a sibling of wrapper/ at the repo root.
  const fallback = join(__dirname, '..', 'turbollm')
  if (existsSync(join(fallback, 'bin', 'turbollm.mjs'))) return fallback
  return null
}

// Owns the daemon's lifetime across requested restarts (daemon-supervisor.js).
let supervisor = null

// ── Auto-update (spec 29 B.2) ─────────────────────────────────────────────────
// The desktop app updates itself through electron-updater against the `latest*.yml`
// manifests electron-builder publishes onto each GitHub release. The npm/CLI install has
// its own mechanism entirely (the daemon's POST /api/v1/app/update + the detached updater
// helper) — this is the desktop half, and the two must never both run: the daemon's
// install-method detection classifies the packaged daemon as `electron` precisely so it
// refuses to shell out to npm inside an app bundle.
//
// TWO HARD PREREQUISITES, both owned by the version-lockstep PR (spec 29 Part C, PR 2),
// which must land before this does anything at all:
//   1. `wrapper/package.json`'s version must equal the published npm version. It has drifted
//      three minors behind (1.9.7 vs 1.12.7). electron-updater compares the APP's own
//      version against `latest.yml`, so with the drift in place the desktop app believes it
//      is AHEAD of every release ever published and will never update — worse than no
//      auto-update, because it looks like it works.
//   2. `electron-builder.config.cjs` needs a `publish:` block, and the release workflow's
//      upload globs need `latest*.yml` / `*.blockmap`. Without those manifests there is
//      nothing for electron-updater to read.
// Until then this whole block no-ops via the require guard below rather than crashing the
// app on a missing dependency.
//
// Unsigned (spec 29 D6): updates install, but each one re-triggers SmartScreen on Windows.
// That is a stated, accepted trade — not something to paper over here.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // every 6h, plus once on launch

function setupAutoUpdate () {
  // Only meaningful in a packaged app: a dev run has no update manifest to compare against
  // and electron-updater throws rather than no-oping.
  if (!app.isPackaged) return
  // Nor on macOS: electron-updater's MacUpdater installs only from a .zip (Squirrel.Mac), and only
  // into a signed app. The mac build is an unsigned dmg (electron-builder.config.cjs), so every check
  // would just fail. The daemon tells mac desktop users to download the new .dmg instead
  // (classifyInstall in turbollm/src/app-update-apply.ts).
  if (process.platform === 'darwin') return

  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch (err) {
    // Dependency not installed yet (see prerequisite 2 above). Degrade to "no auto-update"
    // — never to a failed launch.
    console.warn('electron-updater not available; auto-update disabled:', err.message)
    return
  }

  // Download in the background, install when the user quits anyway (spec 29 D5: desktop
  // defaults to auto-download / notify-to-install). Deliberately NOT autoInstallOnAppQuit
  // = false + a modal: interrupting someone mid-session to ask about an update is the
  // behaviour that trains people to dismiss update prompts forever. "Quits" is an explicit
  // Quit (tray, menu) or one of the app's own: closing the window only hides it to the tray
  // (window-lifecycle.js), and a Windows logoff or shutdown emits no 'quit', so an update
  // downloaded meanwhile waits for the next Quit.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Unsigned builds (D6): electron-updater on Windows otherwise refuses to apply an update
  // whose signature it cannot verify against the installed app's.
  autoUpdater.disableWebInstaller = true

  autoUpdater.on('error', (err) => { console.error('Auto-update error:', err && err.message ? err.message : err) })
  autoUpdater.on('update-available', (info) => { console.log(`Update available: ${info && info.version}`) })
  autoUpdater.on('update-downloaded', (info) => { console.log(`Update downloaded: ${info && info.version} — installs on quit`) })

  const check = () => { autoUpdater.checkForUpdates().catch(() => { /* offline: try again next tick */ }) }
  check()
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS)
  // Don't let the interval hold the app open past a quit.
  app.on('before-quit', () => clearInterval(timer))
}

// ── Health check ──────────────────────────────────────────────────────────────
function waitForDaemon (retryMs = 500, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/healthz`, { timeout: 3000 }, (res) => {
        if (res.statusCode === 200) { resolve() }
        else { setTimeout(tryConnect, retryMs) }
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Daemon health check timed out'))
        else setTimeout(tryConnect, retryMs)
      })
      req.end()
    }
    tryConnect()
  })
}

// ── Spawn the daemon ──────────────────────────────────────────────────────────
// Built for every spawn, so a respawn after a requested restart is launched exactly like
// the first launch: same node, argv, cwd and env, except the port, which is the one the
// window is on (daemonPort below).
function daemonLaunchSpec (port) {
  const node = getDaemonNode()
  const daemonDir = getDaemonDir()

  if (!daemonDir) {
    throw new Error(
      'TurboLLM daemon files not found.\n' +
      'Build the daemon first (`npm run build` in the turbollm repo),\n' +
      'or run the package step (npm run package).'
    )
  }

  const cliPath = join(daemonDir, 'bin', 'turbollm.mjs')

  const daemon = {
    node,
    // --no-open: this window IS the UI. Without it the daemon also opens the system browser on
    // every launch and on every respawn after a requested restart. Passed even though the daemon
    // has its own openBrowserOnStart setting, which a user may have left on for CLI use.
    args: [cliPath, '--port', String(port), '--addr', `127.0.0.1:${port}`, '--no-open'],
  }
  // POSIX: behind a watcher that ends the daemon if this app dies (a crash, a kill), and a stdin
  // lifeline; Windows: in this app's kill-on-close job (daemon-supervisor.js daemonSpawnSpec). The
  // env says TURBOLLM_DESKTOP=1: the daemon's install-method detection (spec 29 B.1) reads it. It
  // can infer the desktop case from `resources/daemon` in its own path, but that is a heuristic over
  // a packaging layout; this is the wrapper stating the fact outright. It matters because getting it
  // wrong means the daemon offering `npm i -g` inside an app bundle, which would "succeed" against
  // an entirely different copy of TurboLLM. It is also what tells the daemon this app will respawn it
  // after a restart (daemon-supervisor.js). The daemon reads both once and removes them from its
  // environment, so nothing it starts inherits them (turbollm/src/util/boot-env.ts).
  return daemonSpawnSpec({ platform: process.platform, node: daemon.node, args: daemon.args, cwd: daemonDir, env: process.env, appPid: process.pid })
}

// The last of each daemon's stderr, for the dialog onDaemonLost shows when the daemon was refused. Bounded: a
// daemon that runs for days writes far more than a dialog shows.
const STDERR_TAIL_BYTES = 4096
// How long that dialog waits for the rest of it: 'exit' can come before the last of a child's stderr has been
// read, while the stream's 'close' cannot. A process that kept the pipe open must not hold the dialog back.
const STDERR_SETTLE_MS = 2000
const daemonStderr = new WeakMap()

function spawnDaemonFrom (spec) {
  const child = spawn(spec.node, spec.args, spec.options)
  let tail = Buffer.alloc(0)
  const closed = new Promise((resolve) => child.stderr.once('close', resolve))
  daemonStderr.set(child, { closed, text: () => tail.toString('utf8') })
  child.stdout.on('data', (data) => { process.stdout.write(data) })
  child.stderr.on('data', (data) => {
    process.stderr.write(data)
    tail = Buffer.concat([tail, data]).subarray(-STDERR_TAIL_BYTES)
  })
  return child
}

function stderrOf (child) {
  const stderr = child && daemonStderr.get(child)
  if (!stderr) return Promise.resolve('')
  let timer
  const settled = new Promise((resolve) => { timer = setTimeout(resolve, STDERR_SETTLE_MS) })
  return Promise.race([stderr.closed, settled]).then(() => {
    clearTimeout(timer)
    return stderr.text()
  })
}

// PORT until a port change in Settings moves the live daemon and then the window (window-guards.js
// daemonPortFor); from then on the window's port, so a respawn comes back where the window is. With no window (macOS
// after a close) the port the running daemon recorded, else the last one known: a window opened again loaded PORT,
// which nothing listened on after a port change.
let knownPort = PORT
function daemonPort () {
  const url = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : ''
  const daemon = supervisor && supervisor.current()
  const recorded = daemon ? recordedPortFor(readDataFile('daemon.pid'), daemon.pid) : null
  knownPort = daemonPortFor(url, APP_ORIGIN, recorded ?? knownPort)
  return knownPort
}

// Set once the daemon was refused because another TurboLLM holds the data dir, or because it may not read or
// write its config.json: from then on the dialog below decides when the app quits, and no window opens.
let daemonRefused = false

function onDaemonLost (reason, { dataDirInUse = false, configAccess = false } = {}) {
  console.error(`TurboLLM daemon ${reason}`)
  if (!dataDirInUse && !configAccess) {
    setImmediate(() => app.quit())
    return
  }
  // The daemon's start guard refused it (turbollm/src/cli.ts): a CLI daemon already uses ~/.turbollm, or another
  // start there is still under way. The app quit here at once, as after a crash, so to the user it opened and
  // vanished, and the refusal, which names that daemon and how to stop it, went to a stderr no one sees.
  // The same for a config.json the daemon may not read or write (another user's, as `sudo turbollm` leaves it):
  // its message says whose the file is and the `sudo chown` that gives it back.
  daemonRefused = true
  const notice = configAccess ? configAccessNotice : dataDirInUseNotice
  stderrOf(supervisor && supervisor.current())
    .then((stderr) => dialog.showMessageBox({ type: 'error', buttons: ['Quit'], ...notice(stderr) }))
    .catch((err) => console.error('Could not show why the daemon was refused:', err.message))
    .finally(() => app.quit())
}

// Keeps links and permission requests from turning this window into a browser (window-guards.js).
function guardWindow (win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, legacyUrl) => {
    // event.url on current Electron; the positional url is the deprecated spelling of the same.
    const url = event.url || legacyUrl
    if (isAppUrl(url, APP_ORIGIN)) return
    event.preventDefault()
    if (isWebUrl(url)) shell.openExternal(url)
  })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
let mainWindow = null
// Set once the daemon first answered /healthz: from then on a request to open the window opens one
// (window-lifecycle.js openAction).
let daemonReady = false
// Set in before-quit: from then on a close lets the window close, so the quit goes on, and nothing
// reopens a window (window-lifecycle.js closeAction, openAction).
let quitting = false
// Windows and Linux. Kept referenced for the app's lifetime: a Tray that is garbage-collected takes
// its icon with it.
let tray = null
let trayNotice = null
// Linux: whether the desktop shows tray icons at all (window-lifecycle.js probeStatusNotifierHost); until the session
// bus has said so, a close minimizes the window rather than hide it under an icon that may show nowhere.
let trayShown = process.platform !== 'linux'
let trayProbe = null
// Asks the session bus again, unless it is being asked: at launch, and at each close of the window, so that the next
// close follows a tray that came or went since (the AppIndicator extension turned on or off).
function probeTray () {
  if (process.platform !== 'linux' || trayProbe) return
  trayProbe = probeStatusNotifierHost({ execFile })
    .then((shown) => { trayShown = shown }, (err) => console.error('Could not ask the session bus for a tray:', err.message))
    .then(() => { trayProbe = null })
}

// The one place a window is opened or brought back: the tray's Open, a click on the tray icon, a
// second launch, a Dock click and the startup window once the daemon answers.
function openMainWindow () {
  const hasWindow = mainWindow !== null && !mainWindow.isDestroyed()
  const action = openAction({ quitting, refused: daemonRefused, daemonReady, hasWindow })
  if (action === 'show') {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (action !== 'create') return
  const port = daemonPort()
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'TurboLLM',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  guardWindow(mainWindow)
  const win = mainWindow
  // Windows and Linux: a close hides the window into the tray (minimizes it on a Linux desktop that shows no tray
  // icon) and the daemon keeps running; Quit is what stops it. During a quit the close goes through (see
  // window-lifecycle.js closeAction).
  win.on('close', (event) => {
    daemonPort() // the port the window is on, for a window or a daemon started once it is gone
    const action = closeAction({ platform: process.platform, quitting, hasTray: tray !== null, trayShown })
    if (action === 'close') return
    event.preventDefault()
    probeTray()
    if (action === 'minimize') win.minimize()
    else win.hide()
    showTrayNoticeOnce(action === 'minimize' ? MINIMIZED_NOTICE : TRAY_NOTICE)
  })

  mainWindow.loadURL(`http://127.0.0.1:${port}`)

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools()
  }
}

// The app's icon at tray size: 16 px with a 32 px rendering for 200% displays on Windows, 32 px on
// Linux, whose panels scale it to their own size. See window-lifecycle.js TRAY_ICON for the file.
function trayImage () {
  const iconPath = app.isPackaged ? join(process.resourcesPath, TRAY_ICON.packaged) : join(__dirname, TRAY_ICON.source)
  const source = nativeImage.createFromPath(iconPath)
  if (source.isEmpty()) return source
  if (process.platform !== 'win32') return source.resize({ width: 32, height: 32, quality: 'best' })
  const image = source.resize({ width: 16, height: 16, quality: 'best' })
  image.addRepresentation({ scaleFactor: 2, buffer: source.resize({ width: 32, height: 32, quality: 'best' }).toPNG() })
  return image
}

// Windows and Linux. A tray that cannot be created leaves tray null, and closing the window then quits
// the app as before (window-lifecycle.js closeAction): a hidden window with no icon to bring it back
// would only be reachable by launching the app again.
function createTray () {
  try {
    tray = new Tray(trayImage())
    tray.setToolTip('TurboLLM')
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate({ open: () => openMainWindow(), quit: () => app.quit() })))
    tray.on('click', () => openMainWindow())
  } catch (err) {
    console.error('Could not create the tray icon; closing the window quits TurboLLM:', err.message)
    tray = null
  }
}

// The first time the window goes to the tray, say once that the app is still running and where Quit
// is: until now closing the window was how the app was quit. A tray balloon on Windows (it needs no
// Start-menu shortcut registered for the app, as an Electron Notification there does), a desktop
// notification on Linux, which names File > Quit where the desktop shows no tray icon (`notice`).
function showTrayNoticeOnce (notice) {
  try {
    if (!trayNotice) trayNotice = createTrayNotice(join(app.getPath('userData'), TRAY_NOTICE_FILE))
    if (!trayNotice.take()) return
    if (process.platform === 'win32') tray.displayBalloon({ title: notice.title, content: notice.body })
    else if (Notification.isSupported()) new Notification({ title: notice.title, body: notice.body }).show()
  } catch (err) {
    console.error('Could not show the tray notice:', err.message)
  }
}

// One app at a time. A second launch (a double-click while the first window still waits on
// /healthz) would start a second daemon on the same data dir, which fails to bind and exits, taking
// the second window with it. The running app shows its window instead, also from the tray or after
// the window was closed on macOS.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

app.on('second-instance', () => openMainWindow())

app.whenReady().then(() => {
  // Quitting already (see requestSingleInstanceLock above): start no daemon and open no window.
  if (!isPrimaryInstance) return

  // Deny by default (Electron's own default grants everything); see window-guards.js.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowPermission(permission, (details && details.requestingUrl) || webContents.getURL(), APP_ORIGIN))
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    allowPermission(permission, requestingOrigin, APP_ORIGIN))

  try {
    supervisor = createDaemonSupervisor({ spawnDaemon: () => spawnDaemonFrom(daemonLaunchSpec(daemonPort())), onDaemonLost })
    supervisor.start()
  }
  catch (err) {
    console.error('Failed to start TurboLLM daemon:', err.message)
    app.quit()
    return
  }

  setupAutoUpdate()

  // From launch, so Quit is in reach while the daemon starts too.
  if (usesTray(process.platform)) createTray()
  probeTray()

  waitForDaemon().then(() => {
    // Refused (onDaemonLost): whatever answers on the port is not this app's daemon.
    if (daemonRefused) return
    daemonReady = true
    openMainWindow()
  }).catch((err) => {
    if (daemonRefused) return // the dialog quits the app once it is answered
    console.error('Daemon failed to start:', err.message)
    app.quit()
  })

  // macOS: a Dock click. Opens no window while the daemon starts (window-lifecycle.js openAction).
  app.on('activate', () => openMainWindow())

  // Closing the window no longer quits the app: the tray (Windows, Linux) or the Dock (macOS) keeps
  // it, and its daemon, running until it is quit. Without this listener Electron quits here on its own.
  app.on('window-all-closed', () => {
    if (quitsWhenAllClosed({ platform: process.platform, hasTray: tray !== null })) app.quit()
  })

  // Every quit comes through here: the tray's Quit, the app menu's Quit (File > Exit on Windows),
  // Cmd+Q / Ctrl+Q, a logoff or shutdown on macOS, a shutdown on Linux (systemd's SIGTERM, which
  // Electron's shutdown-signal handler turns into a quit), and the app's own quits (a daemon lost, a
  // refusal dialog answered). It is what stops the daemon. Electron emits it before it closes the
  // windows, so the flag is set before any close. A Linux logoff comes here only where the desktop,
  // or logind with KillUserProcesses, sends the session's processes SIGTERM (or SIGHUP, which that
  // handler takes the same way): a session that only drops its display connection ends Electron
  // without before-quit, and the daemon then ends by its lifeline (its stdin ends with the app). A
  // Windows logoff or shutdown emits no before-quit either: the system ends the app and its daemon
  // with the session, as it did before the tray.
  //
  // supervisor.stop() ends the daemon's stdin, which runs the daemon's own graceful shutdown, and
  // resolves at its exit (at most 15 s, then it ends the daemon). Where the quit waits for it:
  // - Windows: the quit is held until the daemon has exited, then quits again. Electron's exit would
  //   end the daemon through its job object (daemonSpawnSpec) before its shutdown could run.
  // - Linux: the same. The AppImage's mount (electron-builder.config.cjs) goes away when Electron
  //   exits, and the daemon's node and node_modules live on it: it must finish while they are there.
  // - macOS: never held. A quit prevented during a logout or a shutdown cancels the logout. The
  //   daemon finishes by itself from the .app on disk, and its watcher caps that at 15 s.
  let daemonStopped = false
  let stoppingDaemon = false
  app.on('before-quit', (event) => {
    quitting = true
    if (daemonStopped || !supervisor) return
    if (process.platform === 'darwin') {
      daemonStopped = true
      supervisor.stop()
      return
    }
    event.preventDefault()
    if (stoppingDaemon) return
    stoppingDaemon = true
    supervisor.stop().finally(() => {
      daemonStopped = true
      app.quit()
    })
  })
})
