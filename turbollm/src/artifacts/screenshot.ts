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

export interface ShotOpts {
  /** CSS-px width of the render viewport (a stable desktop width, e.g. 360–1280). */
  width: number
  /** CSS-px height of the render viewport — `vh` units resolve against this. */
  height: number
}

/** Render `html` headless and return a full-page PNG buffer at 2× scale, or null if no browser
 *  is available or rendering fails (caller then falls back to the client-side raster). */
export async function screenshotArtifact(html: string, opts: ShotOpts): Promise<Buffer | null> {
  const exe = findChrome()
  if (!exe) return null
  let puppeteer: typeof import('puppeteer-core')
  try {
    puppeteer = (await import('puppeteer-core')).default as unknown as typeof import('puppeteer-core')
  } catch {
    return null // dependency missing / failed to load
  }
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
  try {
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', ...NO_NETWORK_ARGS],
    })
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
  } catch {
    return null
  } finally {
    try { await browser?.close() } catch { /* ignore */ }
  }
}
