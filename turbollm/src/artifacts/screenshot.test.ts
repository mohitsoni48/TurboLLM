// The server-side artifact render runs model-generated HTML/JS in headless Chrome. Request
// interception there only sees HTTP(S), so the page must also carry the on-screen iframe's CSP —
// and as the FIRST thing parsed, since a meta CSP does not cover anything before it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { createServer, type AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ChromePipeTransport, findChrome, launchSandboxedFirst, reapStaleChromeProfiles, RENDER_DEADLINE_MS, screenshotArtifact, withArtifactCsp } from './screenshot'
import { isGone, killRecorded, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const CSP_START = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';'

test('withArtifactCsp: the CSP is the very first thing in a document without a doctype', () => {
  const out = withArtifactCsp('<script>new WebSocket("wss://x")</script><html><head></head><body>hi</body></html>')
  assert.ok(out.startsWith(CSP_START), out.slice(0, 80))
})

test('withArtifactCsp: it goes right after a leading doctype, so standards mode is kept', () => {
  const out = withArtifactCsp('\n<!DOCTYPE html>\n<html><head><script>1</script></head></html>')
  assert.ok(out.startsWith(`\n<!DOCTYPE html>${CSP_START}`), out.slice(0, 80))
  assert.ok(out.indexOf(CSP_START) < out.indexOf('<script>'))
})

test('withArtifactCsp: it precedes any script, wherever the artifact put its <head>', () => {
  for (const html of [
    '<script>evil()</script><head></head>',
    '<html><script>evil()</script><head><title>x</title></head></html>',
    '<!-- <head> --><script>evil()</script>',
    ' <!doctype html><script>evil()</script>', // not HTML whitespace: no doctype skip
  ]) {
    const out = withArtifactCsp(html)
    assert.ok(out.indexOf(CSP_START) >= 0 && out.indexOf(CSP_START) < out.indexOf('<script>'), html)
  }
  assert.ok(withArtifactCsp(' <!doctype html>').startsWith(CSP_START))
})

test('withArtifactCsp: the policy matches the on-screen iframe (connect-src falls back to none)', () => {
  const out = withArtifactCsp('<p>x</p>')
  assert.match(out, /content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;"/)
})

// A real export of an artifact that tries the ways out that request interception and the CSP
// don't cover: popups (window.open, a target=_blank form and link) and WebRTC (STUN over UDP,
// TURN over TCP), aimed at listeners on loopback and on this machine's LAN address. Only the
// browser's launch flags stop them. Needs an installed Chrome/Chromium/Edge (or CHROME_PATH).
test('screenshotArtifact: neither the artifact nor a popup it opens reaches loopback or the LAN', {
  skip: findChrome() ? false : 'no Chrome/Chromium/Edge found',
  timeout: 60_000,
}, async () => {
  const hits: string[] = []
  const closers: Array<() => void> = []
  try {
    const lan = Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address
    let page = '<!doctype html><body><h1>export</h1>'
    let script = ''
    for (const [i, host] of ['127.0.0.1', ...(lan ? [lan] : [])].entries()) {
      const tcp = createServer((sock) => { hits.push(`tcp ${host}`); sock.destroy() })
      await new Promise<void>((resolve) => tcp.listen(0, host, resolve))
      closers.push(() => tcp.close())
      const udp = createSocket('udp4').on('message', () => hits.push(`udp ${host}`))
      await new Promise<void>((resolve) => udp.bind(0, host, resolve))
      closers.push(() => udp.close())
      const url = `http://${host}:${(tcp.address() as AddressInfo).port}`
      page += `<form id="f${i}" action="${url}/form" method="post" target="_blank"></form><a id="a${i}" href="${url}/link" target="_blank">x</a>`
      script += `window.open('${url}/popup'); document.getElementById('f${i}').submit(); document.getElementById('a${i}').click()
        { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${host}:${udp.address().port}' },
            { urls: 'turn:${host}:${(tcp.address() as AddressInfo).port}?transport=tcp', username: 'u', credential: 'c' }] })
          pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)) }
`
      if (host === '127.0.0.1') script += `window.open('${url.replace('127.0.0.1', 'localhost')}/localhost')\n`
    }
    const png = await screenshotArtifact(`${page}<script>${script}</script></body>`, { width: 800, height: 600 })
    assert.ok(png && png.subarray(1, 4).toString() === 'PNG', 'the export still renders')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(hits, [])
  } finally {
    for (const close of closers) close()
  }
})

test('launchSandboxedFirst: the sandboxed launch goes first; --no-sandbox only as root or as the one retry', async () => {
  const calls: boolean[] = []
  const ok = async (noSandbox: boolean) => { calls.push(noSandbox); return 'browser' }
  assert.equal(await launchSandboxedFirst(ok, false), 'browser')
  assert.deepEqual(calls, [false], 'a user that can sandbox never gets --no-sandbox')

  calls.length = 0
  const noUserns = async (noSandbox: boolean) => {
    calls.push(noSandbox)
    if (!noSandbox) throw new Error('No usable sandbox!')
    return 'browser'
  }
  assert.equal(await launchSandboxedFirst(noUserns, false), 'browser')
  assert.deepEqual(calls, [false, true], 'a failed sandboxed launch is retried once without it')

  calls.length = 0
  await launchSandboxedFirst(ok, true)
  assert.deepEqual(calls, [true], 'root: Chrome refuses a sandboxed start, so no first try')

  calls.length = 0
  const broken = async (noSandbox: boolean) => { calls.push(noSandbox); throw new Error('no browser') }
  await assert.rejects(launchSandboxedFirst(broken, false), /no browser/)
  assert.deepEqual(calls, [false, true], 'no more than one retry')
})

// An artifact whose script never yields held every CDP step (setContent, the fonts wait, the
// screenshot) for puppeteer's 180 s default protocol timeout: about 9 minutes per export click,
// with the renderer pegging a core throughout. A deadline shorter than RENDER_DEADLINE_MS keeps
// this test quick.
test('screenshotArtifact: a script that never yields ends within the render deadline', {
  skip: findChrome() ? false : 'no Chrome/Chromium/Edge found',
  timeout: RENDER_DEADLINE_MS + 30_000,
}, async () => {
  const deadline = 6_000
  const started = Date.now()
  const png = await screenshotArtifact('<html><body>hi<script>for(;;){}</script></body></html>', { width: 800, height: 600 }, deadline)
  const took = Date.now() - started
  assert.equal(png, null, 'falls back like any other failed export')
  assert.ok(took < deadline + 2_000, `took ${took} ms`)
  // A normal export right after still renders.
  const again = await screenshotArtifact('<!doctype html><body><h1>ok</h1></body>', { width: 800, height: 600 })
  assert.ok(again && again.subarray(1, 4).toString() === 'PNG')
})

// ── The export browser is tied to the daemon (util/tether.ts) ───────────────────────────────────────────────────────
// puppeteer.launch started Chrome as a plain child: a daemon that died during an export left its 9 processes running
// (a spinning renderer pegging a core), and puppeteer's SIGINT handler called process.exit(130) in the middle of the
// daemon's graceful shutdown. Chrome's two crash handlers daemonized out of its process group (on macOS Chrome still
// starts one: see the SIGKILL test). Every Chrome test is in this one file, so they never run alongside each other: a
// Chrome process that appears during one is that test's.

const CHROME = findChrome()
const noChrome = !CHROME ? 'no Chrome/Chromium/Edge found' : process.platform === 'win32' ? 'POSIX process groups (Windows ties Chrome through its job sentinel)' : false
const SPIN = '<html><body>spin<script>for(;;){}</script></body></html>'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Where every process of this Chrome lives: the .app bundle on macOS, the executable's directory elsewhere. */
function chromeRoot(exe: string): string {
  const real = realpathSync(exe)
  const app = real.indexOf('.app/')
  return app >= 0 ? real.slice(0, app + 5) : dirname(real) + '/'
}

/** Every live process whose executable is inside Chrome's install (crash handlers included), with its group. */
function chromeProcesses(): Array<{ pid: number; pgid: number; ppid: number; cmd: string }> {
  const root = chromeRoot(CHROME as string)
  const out: Array<{ pid: number; pgid: number; ppid: number; cmd: string }> = []
  if (process.platform === 'linux') {
    for (const d of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      try {
        if (!readlinkSync(`/proc/${d}/exe`).startsWith(root)) continue
        const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (f[0] === 'Z' || f[0] === 'X') continue
        out.push({ pid: Number(d), ppid: Number(f[1]), pgid: Number(f[2]), cmd: readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ') })
      } catch { /* not ours to read, or gone */ }
    }
    return out
  }
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,comm='], { encoding: 'utf8' })
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m || m[4].startsWith('Z') || !m[5].startsWith(root)) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cmd: m[5] })
  }
  return out
}

/** The Chrome processes that appeared since `before`, once the browser under `daemonPid` and a renderer are up. */
async function newChrome(before: Set<number>, daemonPid: number): Promise<{ root: number; all: Array<{ pid: number; pgid: number; cmd: string }> }> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const all = chromeProcesses().filter((p) => !before.has(p.pid))
    const root = all.find((p) => p.ppid === daemonPid)
    if (root && all.some((p) => /--type=renderer/.test(p.cmd) || /Renderer/.test(p.cmd))) {
      await sleep(500) // let every helper start: a crash handler shows up after the browser
      return { root: root.pid, all: chromeProcesses().filter((p) => !before.has(p.pid)) }
    }
    if (Date.now() >= deadline) throw new Error(`no browser and renderer under ${daemonPid}: ${JSON.stringify(all)}`)
    await sleep(50)
  }
}

function sandboxNote(rootPid: number): string {
  const cmd = process.platform === 'linux' ? readFileSync(`/proc/${rootPid}/cmdline`, 'utf8') : String(spawnSync('ps', ['-o', 'args=', '-p', String(rootPid)], { encoding: 'utf8' }).stdout)
  return cmd.includes('--no-sandbox') ? 'Chrome ran with --no-sandbox' : 'Chrome ran sandboxed'
}

test('a daemon SIGKILLed during a spinning export takes every Chrome process with it; none was outside its group', { skip: noChrome, timeout: 60_000 }, async (t) => {
  const runDir = tmpDir('tllm-chrome-run-')
  const before = new Set(chromeProcesses().map((p) => p.pid))
  const d = await startStandInDaemon(`
import { screenshotArtifact } from ${srcUrl('artifacts/screenshot.ts')}
void screenshotArtifact(${JSON.stringify(SPIN)}, { width: 800, height: 600, runDir: ${JSON.stringify(runDir)} }, 120_000)
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { CHROME_PATH: CHROME as string } })
  let pids: number[] = []
  try {
    await d.next()
    const { root, all } = await newChrome(before, d.pid)
    pids = all.map((p) => p.pid)
    record(...pids)
    t.diagnostic(`${sandboxNote(root)}; ${all.length} Chrome processes`)
    // On macOS Chrome starts its crash handler (chrome_crashpad_handler, msedge_crashpad_handler) whatever its flags:
    // --disable-crashpad-for-testing, and puppeteer's --disable-breakpad and --disable-crash-reporter, keep it from
    // starting on Linux only (macos-latest, Chrome 155). It is started outside the browser's group, as the Linux ones
    // were, and ends by itself once the browser and its helpers have: so there it may be outside the group, and it
    // must be gone with the rest below.
    const outside = all.filter((p) => p.pgid !== root)
    const macCrashHandler = (p: { cmd: string }) => process.platform === 'darwin' && /\/[a-z]+_crashpad_handler$/.test(p.cmd)
    assert.deepEqual(outside.filter((p) => !macCrashHandler(p)).map((p) => `${p.cmd} (group ${p.pgid}, the browser's ${root})`), [],
      'every Chrome process is in the browser\'s group: no crash handler outside it (on macOS, none but the one Chrome always starts)')
    t.diagnostic(`outside the browser's group: ${outside.length ? outside.map((p) => p.cmd.split('/').pop()).join(', ') : 'none'}`)
    assert.ok(all.length >= 3, `the browser and its helpers (${all.length})`)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(pids, 2000), [], 'all gone within 2 s, a crash handler outside the group included')
    // The profile it was using stays until the next start sweeps it.
    const left = readdirSync(runDir).filter((n) => n.startsWith('chrome-'))
    assert.equal(left.length, 1, 'the dead daemon\'s profile is left behind')
    assert.equal(reapStaleChromeProfiles(runDir), 1)
    assert.deepEqual(readdirSync(runDir), [])
  } finally {
    killRecorded(d.pid, ...pids)
  }
})

test('Ctrl+C during an export runs the daemon\'s own graceful shutdown, which ends Chrome: no exit 130', { skip: noChrome, timeout: 60_000 }, async () => {
  const runDir = tmpDir('tllm-chrome-sigint-')
  const before = new Set(chromeProcesses().map((p) => p.pid))
  // The daemon's own SIGINT handler (cli.ts): its graceful sequence, then exit 0.
  const d = await startStandInDaemon(`
import { screenshotArtifact } from ${srcUrl('artifacts/screenshot.ts')}
import { stopTethered } from ${srcUrl('util/tether.ts')}
process.on('SIGINT', () => { void stopTethered().then(() => process.exit(0)) })
void screenshotArtifact(${JSON.stringify(SPIN)}, { width: 800, height: 600, runDir: ${JSON.stringify(runDir)} }, 120_000)
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { CHROME_PATH: CHROME as string } })
  let pids: number[] = []
  try {
    await d.next()
    pids = (await newChrome(before, d.pid)).all.map((p) => p.pid)
    record(...pids)
    d.child.kill('SIGINT')
    const { code, signal } = await d.exited
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, 'the graceful shutdown finished (puppeteer\'s handler exited 130)')
    assert.deepEqual(await waitGone(pids, 2000), [], 'and Chrome is gone')
  } finally {
    killRecorded(d.pid, ...pids)
  }
})

test('an export returns a PNG, and afterwards no Chrome and no profile is left; the deadline path leaves none either', { skip: noChrome, timeout: 90_000 }, async () => {
  const runDir = tmpDir('tllm-chrome-normal-')
  const before = new Set(chromeProcesses().map((p) => p.pid))
  const png = await screenshotArtifact('<!doctype html><body style="background:#09f"><h1>hello</h1></body>', { width: 800, height: 600, runDir })
  assert.ok(png && png.subarray(1, 4).toString() === 'PNG')
  const spawned = () => chromeProcesses().filter((p) => !before.has(p.pid)).map((p) => p.pid)
  assert.deepEqual(await waitGone(spawned(), 3000), [], 'no Chrome left')
  assert.deepEqual(readdirSync(runDir), [], 'its profile is removed')

  const deadline = 6_000
  const t0 = Date.now()
  assert.equal(await screenshotArtifact(SPIN, { width: 800, height: 600, runDir }, deadline), null)
  assert.ok(Date.now() - t0 < deadline + 2_000, 'it returns at the deadline')
  const after = spawned()
  record(...after)
  try {
    // Browser.close, then the group kill if Chrome is still there 2 s later.
    assert.deepEqual(await waitGone(after, 6000), [], 'no Chrome left after the deadline')
    for (let i = 0; i < 40 && readdirSync(runDir).length > 0; i++) await sleep(50)
    assert.deepEqual(readdirSync(runDir), [], 'its profile is removed too')
  } finally {
    killRecorded(...after)
  }
})

test('ChromePipeTransport: NUL-framed messages, whole even when a character or a message is split across reads', async () => {
  const toChrome = new PassThrough()
  const fromChrome = new PassThrough()
  const tr = new ChromePipeTransport(toChrome, fromChrome)
  const got: string[] = []
  tr.onmessage = (m) => got.push(m)
  let closed = false
  tr.onclose = () => { closed = true }
  const text = Buffer.from('{"a":"é€"}\0{"b":1}\0{"c":', 'utf8')
  const cut = text.indexOf(0xa9) // inside é's two bytes
  fromChrome.write(text.subarray(0, cut))
  fromChrome.write(text.subarray(cut))
  fromChrome.write(Buffer.from('2}\0', 'utf8'))
  await sleep(20)
  assert.deepEqual(got, ['{"a":"é€"}', '{"b":1}', '{"c":2}'])
  const sent: Buffer[] = []
  toChrome.on('data', (b: Buffer) => sent.push(b))
  tr.send('{"id":1}')
  await sleep(5)
  assert.equal(Buffer.concat(sent).toString(), '{"id":1}\0')
  fromChrome.destroy()
  await sleep(5)
  assert.ok(closed, 'the reply pipe\'s close ends the connection')
})

test('reapStaleChromeProfiles removes the profiles of daemons that are gone (and this one\'s, from a reused pid), and nothing else', () => {
  const runDir = tmpDir('tllm-chrome-reap-')
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  const deadPid = Number(dead.stdout)
  assert.ok(isGone(deadPid))
  for (const name of [`chrome-${deadPid}-AbC123`, `chrome-${process.pid}-xyz789`, `chrome-${process.ppid}-keep01`, 'engine-1.pid.d', 'chrome-notapid-ab']) {
    mkdirSync(join(runDir, name))
  }
  assert.equal(reapStaleChromeProfiles(runDir), 2)
  assert.deepEqual(readdirSync(runDir).sort(), [`chrome-${process.ppid}-keep01`, 'chrome-notapid-ab', 'engine-1.pid.d'].sort())
  assert.equal(reapStaleChromeProfiles(join(runDir, 'missing')), 0)
  assert.ok(existsSync(runDir))
})
