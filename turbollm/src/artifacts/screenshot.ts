// Server-side artifact rasterizer (ADR-121 follow-up). Renders an HTML artifact in a real
// headless Chrome/Chromium via puppeteer-core and returns a pixel-perfect full-page PNG — the
// faithful alternative to the client-side html2canvas path (which reimplements CSS layout and
// can't match the live render). Uses the user's INSTALLED browser (no bundled Chromium), and
// returns null whenever a browser isn't found or anything fails, so the caller falls back to
// the html2canvas export. Self-contained artifacts only: the page carries the on-screen iframe's
// own `default-src 'none'` CSP (see ARTIFACT_CSP), and the browser is launched with no network at
// all (see NO_NETWORK_ARGS), since the artifact's scripts run here too.
//
// The browser is started through util/tether.ts, not puppeteer.launch, and puppeteer attaches to it over Chrome's
// --remote-debugging-pipe (connect with a transport of our own; ConnectOptions.transport is public API). launch()
// started Chrome as a plain child, so a daemon that died during an export (SIGKILL, a crash, an out-of-memory kill)
// left its 9 processes running, a spinning renderer pegging a core, measured alive 11 s later; and it registered a
// SIGINT handler that called process.exit(130), so Ctrl+C during an export cut the daemon's graceful shutdown short.
// Now Chrome's whole group ends with the daemon (and Chrome also exits when its CDP pipe closes), and no handler of
// puppeteer's is registered. --disable-crashpad-for-testing keeps Chrome's two crash handlers from starting: they
// daemonize into sessions of their own, out of the group, and outlived Chrome by 1-4 s. The profile lives in
// `<dataDir>/run/chrome-<daemon pid>-<random>`, removed once Chrome has exited, and reapStaleChromeProfiles removes
// one a daemon that died left behind.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { killTetheredTree, spawnTethered } from '../util/tether'

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

/** Launch flags apart from the sandbox ones. CDP goes over the pipe (fds 3 and 4), so no debugging port is open to
 *  other local processes, and no crash handler starts (see the header). */
const BASE_ARGS = ['--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', ...NO_NETWORK_ARGS, '--remote-debugging-pipe', '--disable-crashpad-for-testing']

/** After Browser.close, how long Chrome may take to exit before its group is killed. */
const CLOSE_GRACE_MS = 2_000

/** A profile directory's name: `chrome-<pid of the daemon that made it>-<random>`. */
const PROFILE_NAME = /^chrome-(\d+)-[A-Za-z0-9]{6}$/

/** CDP over Chrome's --remote-debugging-pipe: requests are written to its fd 3, replies read from its fd 4, each
 *  message NUL-terminated. The same framing as puppeteer's own PipeTransport (internal to it): a message is decoded
 *  only once whole, so a multibyte character split across two reads is not mangled, and each is dispatched on its
 *  own turn. Exported for its test. */
export class ChromePipeTransport {
  onmessage?: (message: string) => void
  onclose?: () => void
  #pending: Buffer[] = []
  #closed = false
  constructor(private readonly toChrome: Writable, fromChrome: Readable) {
    fromChrome.on('data', (chunk: Buffer) => this.#dispatch(chunk))
    fromChrome.on('close', () => this.onclose?.())
    fromChrome.on('error', () => { /* the 'close' that follows ends the connection */ })
    toChrome.on('error', () => { /* Chrome has gone: its reply pipe closes too */ })
  }
  send(message: string): void {
    if (this.#closed) return
    this.toChrome.write(message)
    this.toChrome.write('\0')
  }
  #dispatch(chunk: Buffer): void {
    if (this.#closed) return
    let start = 0
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      this.#pending.push(chunk.subarray(start, end))
      const message = Buffer.concat(this.#pending).toString('utf8')
      this.#pending = []
      setImmediate(() => this.onmessage?.(message))
      start = end + 1
    }
    if (start < chunk.length) this.#pending.push(chunk.subarray(start))
  }
  close(): void {
    this.#closed = true
  }
}

const exited = (child: ChildProcess, ms: number): Promise<boolean> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
  const timer = setTimeout(() => resolve(false), ms)
  child.once('exit', () => { clearTimeout(timer); resolve(true) })
})

/** Remove every export profile in `runDir` whose daemon is gone (or is this process: at boot no export runs), which a
 *  daemon that died during an export left behind. Returns how many. Called once at boot. */
export function reapStaleChromeProfiles(runDir: string): number {
  let names: string[]
  try {
    names = readdirSync(runDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const m = PROFILE_NAME.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    let alive = pid !== process.pid
    if (alive) {
      try {
        process.kill(pid, 0)
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    if (alive) continue
    try {
      rmSync(join(runDir, name), { recursive: true, force: true, maxRetries: 2 })
      removed++
    } catch { /* still in use: the next start tries again */ }
  }
  return removed
}

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
  /** Where the browser's profile directory goes: the daemon passes `<dataDir>/run`, which its boot sweeps. */
  runDir?: string
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
  type Browser = Awaited<ReturnType<typeof puppeteer.connect>>
  const runDir = opts.runDir ?? join(tmpdir(), 'turbollm-chrome')
  let profileDir: string
  try {
    mkdirSync(runDir, { recursive: true })
    profileDir = mkdtempSync(join(runDir, `chrome-${process.pid}-`))
  } catch {
    return null
  }
  const removeProfile = () => { try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* the boot sweep */ } }
  const live: { browser?: Browser; child?: ChildProcess } = {}
  let expired = false
  let timer: NodeJS.Timeout | undefined
  /** Close the browser, kill its group if it has not exited CLOSE_GRACE_MS later, then remove its profile. Browser.close
   *  of a wedged Chrome would wait out the protocol timeout; the kill closes the pipe, which ends that wait. */
  const retire = async (): Promise<void> => {
    const { browser, child } = live
    const closing = browser?.close().catch(() => {})
    if (child && !(await exited(child, CLOSE_GRACE_MS))) {
      killTetheredTree(child, 'SIGKILL')
      await exited(child, CLOSE_GRACE_MS)
    }
    await closing
    removeProfile()
  }
  /** Chrome, tied to the daemon, with puppeteer attached over its CDP pipe. A Chrome that exits at start (no usable
   *  sandbox) closes its pipe, so the connect rejects and launchSandboxedFirst retries. */
  const start = async (noSandbox: boolean): Promise<{ browser: Browser; child: ChildProcess }> => {
    const args = await puppeteer.defaultArgs({
      browser: 'chrome',
      headless: true,
      userDataDir: profileDir,
      args: [...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []), ...BASE_ARGS],
    })
    const child = spawnTethered(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true }, { kind: 'chrome' })
    child.on('error', () => { /* its pipes close, so the connect below rejects */ })
    try {
      const browser = await puppeteer.connect({
        transport: new ChromePipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable),
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
        defaultViewport: null,
      })
      return { browser, child }
    } catch (e) {
      if (child.exitCode === null && child.signalCode === null) killTetheredTree(child, 'SIGKILL') // started, never answered
      await exited(child, CLOSE_GRACE_MS)
      throw e
    }
  }
  const render = async (): Promise<Buffer | null> => {
    const started = await launchSandboxedFirst(async (noSandbox) => {
      // A sandboxed launch that failed after the deadline gets no retry: nobody waits for it.
      if (expired) throw new Error('export deadline passed')
      return start(noSandbox)
    })
    live.browser = started.browser
    live.child = started.child
    const browser = started.browser
    // The deadline passed during the launch: nothing else will close this one.
    if (expired) { void retire(); return null }
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
      // No browser came up at all (both launches failed): nothing else removes its profile.
      render().catch(() => { if (!live.child) removeProfile(); return null }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { expired = true; resolve(null) }, deadlineMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    // Past the deadline the close is not awaited, so the export returns at the deadline. A
    // spinning renderer does not hold the close up (the browser process ends its renderers, in
    // about 0.1 s against a for(;;){} page), and Browser.close runs under the protocol timeout
    // above; a Chrome still running CLOSE_GRACE_MS after it has its group killed (taskkill /T on
    // Windows). A launch still in flight at the deadline is retired by render itself.
    if (expired) { if (live.child) void retire() } else if (live.child) await retire()
  }
}
