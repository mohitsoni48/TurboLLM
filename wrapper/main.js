// main.js — TurboLLM Desktop native wrapper
// Spawns the TurboLLM daemon (bundled under resources/daemon/), waits for /healthz,
// then opens a native window pointed at http://localhost:6996.
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const { spawn } = require('child_process')
const http = require('http')
const { existsSync } = require('fs')

const PORT = process.env.TURBOLLM_PORT || 6996

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

let daemonProcess = null

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
  // behaviour that trains people to dismiss update prompts forever.
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
function launchDaemon () {
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

  daemonProcess = spawn(node, [cliPath, '--port', String(PORT), '--addr', `127.0.0.1:${PORT}`], {
    cwd: daemonDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // hide the console window on Windows
    // The daemon's install-method detection (spec 29 B.1) reads this. It can infer the
    // desktop case from `resources/daemon` in its own path, but that is a heuristic over a
    // packaging layout; this is the wrapper stating the fact outright. It matters because
    // getting it wrong means the daemon offering `npm i -g` inside an app bundle, which
    // would "succeed" against an entirely different copy of TurboLLM.
    env: { ...process.env, TURBOLLM_DESKTOP: '1' },
  })

  daemonProcess.stdout.on('data', (data) => { process.stdout.write(data) })
  daemonProcess.stderr.on('data', (data) => { process.stderr.write(data) })

  daemonProcess.on('exit', (code, signal) => {
    if (code !== 0 && daemonProcess.exitCode === code) {
      console.error(`TurboLLM daemon exited (code=${code}, signal=${signal || 'none'})`)
      setImmediate(() => app.quit())
    }
  })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
let mainWindow = null

app.whenReady().then(() => {
  try { launchDaemon() }
  catch (err) {
    console.error('Failed to start TurboLLM daemon:', err.message)
    app.quit()
    return
  }

  setupAutoUpdate()

  waitForDaemon().then(() => {
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

    mainWindow.loadURL(`http://127.0.0.1:${PORT}`)

    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools()
    }
  }).catch((err) => {
    console.error('Daemon failed to start:', err.message)
    app.quit()
  })

  // macOS: double-click dock icon
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = new BrowserWindow({
        width: 1200, height: 800, minWidth: 800, minHeight: 600,
        title: 'TurboLLM', backgroundColor: '#0a0a0a',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      })
      mainWindow.loadURL(`http://127.0.0.1:${PORT}`)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    if (daemonProcess && !daemonProcess.exitCode) {
      daemonProcess.kill('SIGTERM')
      setTimeout(() => {
        if (daemonProcess && daemonProcess.exitCode === null) daemonProcess.kill('SIGKILL')
      }, 5000)
    }
  })

  app.on('unexpected-shutdown', () => {
    if (daemonProcess && !daemonProcess.exitCode) daemonProcess.kill('SIGTERM')
  })
})
