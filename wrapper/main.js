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
function getDaemonNode () {
  // In the packaged app, process.resourcesPath points to <app>/resources/
  // The Electron runtime has a built-in Node.js, but to run the daemon as a
  // standalone Node process we need the actual node.exe. electron-packager
  // doesn't bundle one, so we copy it from electron's resources or use
  // the system path. For the packaged build, we'll use process.execPath
  // which is TurboLLM.exe itself — it contains Node.js at runtime.
  if (process.resourcesPath) {
    const bundled = join(process.resourcesPath, 'node.exe')
    if (existsSync(bundled)) return bundled
  }
  return process.execPath
}

function getDaemonDir () {
  // In the packaged app, daemon sits at <app>/resources/daemon/
  if (process.resourcesPath) {
    const daemonDir = join(process.resourcesPath, 'daemon')
    if (existsSync(join(daemonDir, 'cli.js'))) return daemonDir
  }
  // Dev fallback: turbollm/dist/ alongside this wrapper
  const fallback = join(__dirname, '..', '..', 'turbollm', 'dist')
  if (existsSync(join(fallback, 'cli.js'))) return fallback
  return null
}

let daemonProcess = null

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

  const cliPath = join(daemonDir, 'cli.js')

  daemonProcess = spawn(node, [cliPath, '--port', String(PORT), '--addr', `127.0.0.1:${PORT}`], {
    cwd: daemonDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // hide the console window on Windows
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
