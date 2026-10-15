// window-guards.js — what the desktop window may open, navigate to and be granted.
// Electron-free on purpose (like daemon-supervisor.js), so it can be tested under plain `node --test`;
// main.js wires it into Electron's window-open, will-navigate and permission handlers.
//
// The window shows the daemon's web UI, and that UI renders links it does not control (chat output,
// HF model cards) as target="_blank". Electron's defaults would open each one as a new in-app window
// with no address bar, so a phishing page looks like TurboLLM, and would grant that page every
// permission it asks for (camera, microphone, location) without any prompt. So only the app's own
// pages stay in the app, web links go to the system browser, and permissions are denied unless the
// UI itself needs them. It also says which port a (re)spawned daemon binds: the one the window is on.

// Everything the web UI asks for: copy buttons (navigator.clipboard.writeText, web/src/lib/clipboard.ts)
// and routine-finished notifications (web/src/lib/notify-routine.ts). Anything else is denied.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications'])

/** The origin the daemon serves the UI on: what main.js loads into the window. Normalized the way the
 *  page's own URL will be; a TURBOLLM_PORT that is not a port at all must not throw at startup. */
function appOriginFor (port) {
  try {
    return new URL(`http://127.0.0.1:${port}`).origin
  } catch {
    return `http://127.0.0.1:${port}`
  }
}

/** The app's own pages: the app origin's scheme and host (http://127.0.0.1), on ANY port. Not the
 *  exact origin: a port change in Settings moves the daemon, and the UI then sends this window to
 *  http://127.0.0.1:<new port> (SettingsScreen.tsx handleSave). Refusing that hop would leave the
 *  window on a port nothing listens on and open the new one in the browser. */
function isAppUrl (url, appOrigin) {
  try {
    const target = new URL(url)
    const app = new URL(appOrigin)
    return target.protocol === app.protocol && target.hostname === app.hostname
  } catch {
    return false
  }
}

/** The port a daemon this app spawns must listen on: the port of the app page the window shows, else
 *  the launch port (no window yet, or not on an app page). After a port change in Settings the
 *  window is on the new port (see isAppUrl), and so is the live daemon; the daemon's --port is only
 *  read at boot. A respawn on the launch port would leave the window, and the restart overlay that
 *  polls and reloads the window's own origin, on a port nothing listens on. */
function daemonPortFor (windowUrl, appOrigin, launchPort) {
  if (isAppUrl(windowUrl, appOrigin)) {
    const { port } = new URL(windowUrl)
    if (port) return port
  }
  return String(launchPort)
}

/** http(s) only: the one kind of link worth handing to the system browser. Never file:, javascript:
 *  or a custom scheme that would launch some other app. */
function isWebUrl (url) {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** A permission is granted only to the app's own pages (see isAppUrl: any port, so it survives a
 *  port change), and only if the UI needs it. */
function allowPermission (permission, requestingUrl, appOrigin) {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl, appOrigin)
}

module.exports = { ALLOWED_PERMISSIONS, allowPermission, appOriginFor, daemonPortFor, isAppUrl, isWebUrl }
