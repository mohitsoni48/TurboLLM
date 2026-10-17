// Server-side artifact rasterizer (ADR-121 follow-up). Renders an HTML artifact in a real
// headless Chrome/Chromium via puppeteer-core and returns a pixel-perfect full-page PNG — the
// faithful alternative to the client-side html2canvas path (which reimplements CSS layout and
// can't match the live render). Uses the user's INSTALLED browser (no bundled Chromium), and
// returns null whenever a browser isn't found or anything fails, so the caller falls back to
// the html2canvas export. Self-contained artifacts only: the page carries the on-screen iframe's
// own `default-src 'none'` CSP (see ARTIFACT_CSP), and the browser is launched with no network at
// all (see NO_NETWORK_ARGS), since the artifact's scripts run here too.
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Candidate executables for the platform, in preference order (Chrome → Edge → Chromium). */
function chromeCandidates(): string[] {
  const env = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH
  const out: string[] = env ? [env] : []
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files'
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] || ''
    for (const base of [pf, pfx86, local].filter(Boolean)) {
      out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
    for (const base of [pfx86, pf].filter(Boolean)) {
      out.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (process.platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    )
  } else {
    // Linux: try common absolute paths, then resolve names on PATH via `which`.
    out.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    )
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try {
        const p = execFileSync('which', [name], { encoding: 'utf-8' }).trim()
        if (p) out.push(p)
      } catch { /* not on PATH */ }
    }
  }
  return out
}

/** Path to an installed Chrome/Chromium/Edge, or null if none is found. */
export function findChrome(): string | null {
  for (const p of chromeCandidates()) {
    try {
      if (p && existsSync(p)) return p
    } catch { /* ignore */ }
  }
  return null
}

/** The on-screen artifact iframe's CSP (`buildSrcdoc` in web/src/components/ArtifactCard.tsx),
 *  copied by hand — the daemon and the web bundle share no module, so keep the two in sync. The
 *  render below runs the artifact's scripts too, and request interception only ever sees HTTP(S)
 *  requests: a WebSocket/EventSource connection is never paused by it. `default-src 'none'`
 *  (which `connect-src` falls back to) refuses those as well. */
const ARTIFACT_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`

/** `html` with {@link ARTIFACT_CSP} as the very first thing the parser sees. A meta CSP only
 *  governs what is parsed AFTER it, so injecting it into the artifact's own `<head>` would leave
 *  anything the model placed before that tag unrestricted. It goes after a leading doctype, if
 *  any, so the page keeps standards mode — matched with HTML's own whitespace only: any other
 *  leading character would open `<body>` first, where a meta CSP is ignored. */
export function withArtifactCsp(html: string): string {
  const doctype = /^[\t\n\f\r ]*<!doctype[^>]*>/i.exec(html)
  return doctype ? doctype[0] + ARTIFACT_CSP + html.slice(doctype[0].length) : ARTIFACT_CSP + html
}

/** Takes the export browser off the network. Request interception and the CSP only cover the
 *  artifact's own page: a popup it opens (window.open, a target=_blank form or link; puppeteer
 *  turns the popup blocker off, and page.evaluate grants a user gesture anyway) loaded loopback,
 *  LAN and internet URLs, and WebRTC sent STUN/TURN traffic from either. So every request goes to
 *  a proxy on the discard port, where nothing listens; `<-loopback>` drops Chrome's built-in
 *  bypass for localhost/127.0.0.1, and WebRTC may only use UDP through that proxy (none). The page
 *  itself loads with setContent and data:/blob: URLs, which never touch the network. */
const NO_NETWORK_ARGS = [
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
]

/** The whole export (launch, render, screenshot) must finish within this, or the browser is
 *  killed and the export falls back like any other failure. The artifact's scripts run here, and
 *  the 8 s load timeout below only starts once Page.setDocumentContent has returned: a script that
 *  never yields (`for(;;){}`) held setContent, the fonts wait and the screenshot for puppeteer's
 *  default 180 s protocol timeout each, so one click on PNG/JPEG pegged a core for about 9 minutes
 *  while the export spinner waited. Room for a cold browser start plus that 8 s load wait. */
export const RENDER_DEADLINE_MS = 20_000

/** Per-CDP-call limit, in place of puppeteer's 180 s default, so no single step can outlast the
 *  deadline above on its own. A full-page screenshot of a long artifact takes a few seconds. */
const PROTOCOL_TIMEOUT_MS = 15_000

/** Launch flags apart from the sandbox ones. */
const BASE_ARGS = ['--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', ...NO_NETWORK_ARGS]

/** Runs `launch` with Chrome's sandbox on, and only falls back to `--no-sandbox` where Chrome
 *  cannot set one up. The export runs the artifact's (model-written, possibly prompt-injected)
 *  scripts, and the sandbox is what keeps a renderer exploit in them away from the user's files;
 *  every export used to launch with `--no-sandbox`. Chrome refuses a sandboxed start as root, so
 *  root goes straight to `--no-sandbox`; elsewhere a sandboxed launch that fails (a container
 *  without user namespaces or the setuid helper) is retried once without it. */
export async function launchSandboxedFirst<T>(
  launch: (noSandbox: boolean) => Promise<T>,
  root: boolean = process.getuid?.() === 0,
): Promise<T> {
  if (root) return launch(true)
  try {
    return await launch(false)
  } catch {
    return launch(true)
  }
}

export interface ShotOpts {
  /** CSS-px width of the render viewport (a stable desktop width, e.g. 360–1280). */
  width: number
  /** CSS-px height of the render viewport — `vh` units resolve against this. */
  height: number
}

/** Render `html` headless and return a full-page PNG buffer at 2× scale, or null if no browser
 *  is available, rendering fails or it outlasts `deadlineMs` (caller then falls back to the
 *  client-side raster). Only tests pass a `deadlineMs` other than {@link RENDER_DEADLINE_MS}. */
export async function screenshotArtifact(html: string, opts: ShotOpts, deadlineMs: number = RENDER_DEADLINE_MS): Promise<Buffer | null> {
  const exe = findChrome()
  if (!exe) return null
  let puppeteer: typeof import('puppeteer-core')
  try {
    puppeteer = (await import('puppeteer-core')).default as unknown as typeof import('puppeteer-core')
  } catch {
    return null // dependency missing / failed to load
  }
  type Browser = Awaited<ReturnType<typeof puppeteer.launch>>
  const live: { browser?: Browser } = {}
  let expired = false
  let timer: NodeJS.Timeout | undefined
  const render = async (): Promise<Buffer | null> => {
    const browser = await launchSandboxedFirst(async (noSandbox) => {
      // A sandboxed launch that failed after the deadline gets no retry: nobody waits for it.
      if (expired) throw new Error('export deadline passed')
      return puppeteer.launch({
        executablePath: exe,
        headless: true,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
        args: [...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []), ...BASE_ARGS],
      })
    })
    live.browser = browser
    // The deadline passed during the launch: nothing else will close this one.
    if (expired) { void browser.close().catch(() => {}); return null }
    const page = await browser.newPage()
    await page.setViewport({
      width: Math.max(360, Math.round(opts.width)),
      height: Math.max(480, Math.round(opts.height)),
      deviceScaleFactor: 2,
    })
    // Fail this page's network requests at once, as the on-screen iframe (CSP default-src none)
    // does, rather than waiting on the dead proxy. Popups are not covered here: NO_NETWORK_ARGS is
    // what keeps them (and WebRTC) off the network. Inline styles/scripts and data:/blob: URLs work.
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const u = req.url()
      if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:')) void req.continue()
      else void req.abort()
    })
    await page.setContent(withArtifactCsp(html), { waitUntil: 'load', timeout: 8000 }).catch(() => {})
    // Wait for web-font readiness (string form avoids needing the DOM lib in this Node module).
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
    const buf = await page.screenshot({ type: 'png', fullPage: true })
    return Buffer.from(buf)
  }
  try {
    return await Promise.race([
      render().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { expired = true; resolve(null) }, deadlineMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    // Past the deadline the close is not awaited, so the export returns at the deadline. A
    // spinning renderer does not hold the close up (the browser process ends its renderers, in
    // about 0.1 s against a for(;;){} page), and Browser.close runs under the protocol timeout
    // above; when it fails, puppeteer kills the browser's process tree (taskkill /T on Windows).
    if (expired) void live.browser?.close().catch(() => {})
    else try { await live.browser?.close() } catch { /* ignore */ }
  }
}
