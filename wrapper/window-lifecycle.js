// window-lifecycle.js — what closing, reopening and quitting the desktop window do.
// Electron-free on purpose (like window-guards.js and daemon-supervisor.js), so it can be tested under plain
// `node --test`; main.js wires it into the window's close event, the tray icon, second-instance, activate and
// before-quit.
//
// The daemon is a server and the window is only its frontend, like a browser tab on a `turbollm` started from a
// terminal: closing the window must not stop the daemon or anything it runs (a reply, a Code run, a download, a
// build, an auto-tune, a routine). Until now, on Windows and Linux, closing the window quit the app, and the quit
// stopped the daemon (main.js before-quit → daemon-supervisor.js stop()), ending all of it. Now the window hides to
// a tray icon there and the app runs until it is quit, from the tray's Quit TurboLLM or the window menu's File >
// Exit (Windows) or File > Quit and Ctrl+Q (Linux), or until a logoff or shutdown ends it (main.js before-quit says
// which of those are a quit). macOS already kept the app running in the Dock with no window open, and still does.

const { statSync } = require('node:fs')
const { dirname, isAbsolute, join } = require('node:path')

/** The OS notification shown the first time the window is closed into the tray (see createTrayNotice). */
const TRAY_NOTICE = { title: 'TurboLLM', body: 'TurboLLM is still running. Quit it from the tray icon.' }

/** The same notice on a Linux desktop that shows no tray icon, where a close minimizes the window (closeAction). */
const MINIMIZED_NOTICE = { title: 'TurboLLM', body: 'TurboLLM is still running, minimized. Quit it from File > Quit.' }

/** The tray icon is the app's icon. build/icon.png is electron-builder's icon source, but the `files` allowlist
 *  keeps wrapper/build out of the packaged app, so electron-builder.config.cjs copies it into the app's resources
 *  folder (process.resourcesPath, on all three OSes) as `packaged`. packaging.test.js pins that copy. */
const TRAY_ICON = { source: 'build/icon.png', packaged: 'tray-icon.png' }

/** The file in the app's userData folder that remembers the tray notice was shown. */
const TRAY_NOTICE_FILE = 'tray-notice.json'

/** Windows and Linux keep the app in a tray icon while its window is closed. macOS keeps it in the Dock (its own
 *  convention: an app stays running with no window, and a Dock click opens one), so it gets no tray icon. */
function usesTray (platform) {
  return platform !== 'darwin'
}

/**
 * What closing the main window does.
 * - 'hide': Windows and Linux, with a tray icon. The close is cancelled and the window hidden, so the app, its
 *   daemon and the page itself keep running; the tray or a second launch shows the same window again.
 * - 'minimize': Linux, with a tray icon no tray shows (`trayShown` false: see probeStatusNotifierHost). Hidden, the
 *   window could only be found by launching the app again, and the notice pointed at an icon the user cannot see;
 *   minimized, it stays in the window list and the app and its daemon keep running all the same.
 * - 'close': the window closes. On macOS the app stays in the Dock, as before. During a quit (`quitting`, set in
 *   before-quit) on every platform: a cancelled close cancels the whole quit, so hiding there would turn the tray's
 *   Quit, the app menu's Quit, Ctrl+Q or a logoff into "hide the window" and leave the daemon running. And with no
 *   tray icon (it could not be created) there would be no way back to a hidden window, so it closes and the app
 *   quits as before (quitsWhenAllClosed).
 * @param {{ platform: NodeJS.Platform, quitting: boolean, hasTray: boolean, trayShown?: boolean }} state
 * @returns {'hide'|'minimize'|'close'}
 */
function closeAction ({ platform, quitting, hasTray, trayShown = true }) {
  if (quitting || !usesTray(platform) || !hasTray) return 'close'
  return platform === 'linux' && !trayShown ? 'minimize' : 'hide'
}

/** The calls that ask the session bus whether tray icons show, as Electron's tray icon asks when it is created on
 *  Linux (Chromium's StatusIconLinuxDbus): whether a StatusNotifierWatcher has an owner (KDE's, the AppIndicator
 *  extension's on GNOME), and then whether a StatusNotifierHost, which draws the icons, has registered with it. With
 *  either answer no, the icon falls back to a GTK status icon, which GNOME and Wayland show nowhere. Per tool, those
 *  two calls: GLib's gdbus first, which Electron's own GTK needs, else dbus-send. */
const STATUS_NOTIFIER_PROBES = [
  ['gdbus', [
    ['call', '--session', '--timeout', '2', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher'],
    ['call', '--session', '--timeout', '2', '--dest', 'org.kde.StatusNotifierWatcher', '--object-path', '/StatusNotifierWatcher',
      '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered'],
  ]],
  ['dbus-send', [
    ['--session', '--print-reply', '--reply-timeout=2000', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner', 'string:org.kde.StatusNotifierWatcher'],
    ['--session', '--print-reply', '--reply-timeout=2000', '--dest=org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
      'org.freedesktop.DBus.Properties.Get', 'string:org.kde.StatusNotifierWatcher', 'string:IsStatusNotifierHostRegistered'],
  ]],
]

/** Whether `path` is a socket. */
function isSocket (path) {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

/** The session bus the probes ask, as a D-Bus address: DBUS_SESSION_BUS_ADDRESS, else the user's bus socket
 *  ($XDG_RUNTIME_DIR/bus, where systemd and dbus-broker put it) when it exists, else null. With no address either tool
 *  autolaunches a bus of its own (`dbus-launch --autolaunch`, with an X display), which no tray registers with and
 *  which outlives the probe, so the probes then do not run.
 *  @param {NodeJS.ProcessEnv} env
 *  @param {(path: string) => boolean} [socketAt]
 *  @returns {string|null} */
function sessionBusAddress (env, socketAt = isSocket) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env.DBUS_SESSION_BUS_ADDRESS
  const runtime = env.XDG_RUNTIME_DIR
  if (!runtime || !isAbsolute(runtime) || !socketAt(join(runtime, 'bus'))) return null
  // A D-Bus address value escapes every byte but these as %xx.
  const escaped = Array.from(Buffer.from(join(runtime, 'bus')), (b) =>
    /[-0-9A-Za-z_/.\\*]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).padStart(2, '0')}`).join('')
  return `unix:path=${escaped}`
}

/** Whether a tray icon shows on this Linux desktop: the session bus says a StatusNotifierWatcher has an owner and a
 *  StatusNotifierHost registered with it. False when it says either is missing, when the second call fails, when there
 *  is no session bus to ask (sessionBusAddress), and when neither tool answers the first call within `timeoutMs` (no
 *  tool): a window minimized under a tray that shows is still at hand, one hidden under none is not. Both tools are
 *  given the bus's address, so neither looks for one itself.
 *  @param {{ execFile: typeof import('node:child_process').execFile, timeoutMs?: number, env?: NodeJS.ProcessEnv,
 *    socketAt?: (path: string) => boolean }} deps
 *  @returns {Promise<boolean>} */
async function probeStatusNotifierHost ({ execFile, timeoutMs = 3000, env = process.env, socketAt = isSocket }) {
  const address = sessionBusAddress(env, socketAt)
  if (address === null) return false
  const options = { timeout: timeoutMs, env: { ...env, DBUS_SESSION_BUS_ADDRESS: address } }
  const ask = (command, args) => new Promise((resolve) => {
    execFile(command, args, options, (err, stdout) => resolve(err ? null : String(stdout)))
  })
  // gdbus prints a boolean as `(true,)` and a property's variant as `(<true>,)`; dbus-send prints `boolean true`.
  const yes = (answer) => /\(<?true>?,\)|\bboolean true\b/.test(answer)
  for (const [command, [watcher, host]] of STATUS_NOTIFIER_PROBES) {
    const owned = await ask(command, watcher)
    if (owned === null) continue
    if (!yes(owned)) return false
    const registered = await ask(command, host)
    return registered !== null && yes(registered)
  }
  return false
}

/** Whether the app quits once its last window has closed: only on Windows and Linux when there is no tray icon to
 *  get the window back from (see closeAction). With one, the app stays until it is quit; macOS never quits here. */
function quitsWhenAllClosed ({ platform, hasTray }) {
  return usesTray(platform) && !hasTray
}

/**
 * What a request to open the main window does: the tray's Open, a click on the tray icon, a second launch
 * (second-instance), a Dock click (macOS activate), and the window the app opens once its daemon answers.
 * - 'none': the daemon is still starting (the window opens on its own once it answers: one opened earlier would
 *   load the port before anything listens on it, and the startup window would then open beside it), the daemon
 *   was refused (main.js onDaemonLost: its dialog quits the app), or the app is quitting (nothing reopens a window
 *   a quit is closing).
 * - 'show': a window exists (hidden in the tray, minimized or behind others): it is restored and focused, never
 *   duplicated.
 * - 'create': no window, or it was closed (macOS): a new one opens.
 * @param {{ quitting: boolean, refused: boolean, daemonReady: boolean, hasWindow: boolean }} state
 * @returns {'none'|'show'|'create'}
 */
function openAction ({ quitting, refused, daemonReady, hasWindow }) {
  if (quitting || refused || !daemonReady) return 'none'
  return hasWindow ? 'show' : 'create'
}

/** The tray icon's menu, as an Electron Menu template: Open TurboLLM shows the window, Quit TurboLLM quits the app
 *  (and so stops the daemon).
 *  @param {{ open: () => void, quit: () => void }} actions
 *  @returns {Array<{ label: string, click: () => void } | { type: 'separator' }>} */
function trayMenuTemplate ({ open, quit }) {
  return [
    { label: 'Open TurboLLM', click: () => open() },
    { type: 'separator' },
    { label: 'Quit TurboLLM', click: () => quit() },
  ]
}

/**
 * The first-time tray notice: due once, the first time the window is closed into the tray, and remembered in a
 * small JSON file (`file`, in the app's userData) so later launches never show it again. Remembered in memory too:
 * a write that fails (a read-only userData) shows it once per launch, not on every close. A missing, unreadable or
 * corrupt file reads as "not shown yet".
 * @param {string} file
 * @param {Pick<typeof import('node:fs'), 'readFileSync'|'writeFileSync'|'mkdirSync'>} [fs]
 * @returns {{ take(): boolean }} take() is true when the notice is due, and from then on false.
 */
function createTrayNotice (file, fs = require('node:fs')) {
  let shown = null
  return {
    take () {
      if (shown === null) shown = readShown(file, fs)
      if (shown) return false
      shown = true
      try {
        fs.mkdirSync(dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ shown: true }) + '\n')
      } catch (err) {
        console.error('Could not remember that the tray notice was shown:', err.message)
      }
      return true
    },
  }
}

function readShown (file, fs) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).shown === true
  } catch {
    return false
  }
}

module.exports = {
  MINIMIZED_NOTICE,
  STATUS_NOTIFIER_PROBES,
  TRAY_ICON,
  TRAY_NOTICE,
  TRAY_NOTICE_FILE,
  closeAction,
  createTrayNotice,
  openAction,
  probeStatusNotifierHost,
  quitsWhenAllClosed,
  sessionBusAddress,
  trayMenuTemplate,
  usesTray,
}
