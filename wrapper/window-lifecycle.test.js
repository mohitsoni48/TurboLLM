// window-lifecycle.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createServer } = require('node:net')

const {
  MINIMIZED_NOTICE, STATUS_NOTIFIER_PROBES, TRAY_NOTICE, TRAY_NOTICE_FILE, closeAction, createTrayNotice, openAction,
  probeStatusNotifierHost, quitsWhenAllClosed, sessionBusAddress, trayMenuTemplate, usesTray,
} = require('./window-lifecycle')

// Until now closing the window on Windows and Linux quit the app, and the quit stopped the daemon
// and everything it ran.
test('closeAction: on Windows and Linux a close hides the window to the tray', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(usesTray(platform), true, platform)
    assert.equal(closeAction({ platform, quitting: false, hasTray: true }), 'hide', platform)
    assert.equal(quitsWhenAllClosed({ platform, hasTray: true }), false, `${platform}: no quit when the window is gone`)
  }
})

test('closeAction: macOS closes the window and keeps the app in the Dock, as before', () => {
  assert.equal(usesTray('darwin'), false)
  assert.equal(closeAction({ platform: 'darwin', quitting: false, hasTray: false }), 'close')
  assert.equal(quitsWhenAllClosed({ platform: 'darwin', hasTray: false }), false)
})

// A cancelled close cancels the quit: hiding here would turn every Quit into "hide the window".
test('closeAction: during a quit the window closes on every platform, so the quit goes on', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.equal(closeAction({ platform, quitting: true, hasTray: true }), 'close', platform)
  }
})

// GNOME without the AppIndicator extension has no StatusNotifierWatcher, so the tray icon shows nowhere: a window
// hidden under it could only be found by launching the app again.
test('closeAction: on a Linux desktop that shows no tray icon a close minimizes the window instead', () => {
  assert.equal(closeAction({ platform: 'linux', quitting: false, hasTray: true, trayShown: false }), 'minimize')
  assert.equal(closeAction({ platform: 'linux', quitting: false, hasTray: true, trayShown: true }), 'hide')
  assert.equal(closeAction({ platform: 'win32', quitting: false, hasTray: true, trayShown: false }), 'hide', 'Windows always shows its tray')
  assert.equal(closeAction({ platform: 'darwin', quitting: false, hasTray: false, trayShown: false }), 'close')
  assert.equal(closeAction({ platform: 'linux', quitting: true, hasTray: true, trayShown: false }), 'close', 'a quit goes on')
  assert.equal(quitsWhenAllClosed({ platform: 'linux', hasTray: true }), false)
  assert.doesNotMatch(MINIMIZED_NOTICE.body, /tray/i)
  assert.match(MINIMIZED_NOTICE.body, /still running.*File > Quit/)
})

/** A stand-in execFile answering each command with `answers[command]` (a string: its stdout; else an error), or, for
 *  the property read, `answers[`${command} host`]` when given; `calls` lists the commands run (` host` added for the
 *  property read), their timeout and the bus address they were given (in their env, else this process's). */
function fakeExecFile (answers) {
  const calls = []
  const execFile = (command, args, options, callback) => {
    const name = args.some((a) => a.endsWith('IsStatusNotifierHostRegistered')) ? `${command} host` : command
    calls.push({ command: name, timeout: options.timeout, bus: (options.env || process.env).DBUS_SESSION_BUS_ADDRESS })
    const answer = name in answers ? answers[name] : answers[command]
    setImmediate(() => (typeof answer === 'string' ? callback(null, answer, '') : callback(answer || new Error('ENOENT'), '', '')))
  }
  return { execFile, calls }
}

test('probeStatusNotifierHost: whether the session bus has a StatusNotifierWatcher with a host registered, by gdbus, else dbus-send; no answer is none', async () => {
  const BUS = 'unix:path=/run/user/1000/bus'
  const probe = async (answers) => {
    const { execFile, calls } = fakeExecFile(answers)
    const shown = await probeStatusNotifierHost({ execFile, timeoutMs: 1000, env: { DBUS_SESSION_BUS_ADDRESS: BUS } })
    for (const call of calls) assert.equal(call.bus, BUS, 'the session\'s own bus')
    return { shown, calls: calls.map(({ command, timeout }) => ({ command, timeout })) }
  }
  const both = (command) => [{ command, timeout: 1000 }, { command: `${command} host`, timeout: 1000 }]
  assert.deepEqual(await probe({ gdbus: '(true,)\n', 'gdbus host': '(<true>,)\n' }), { shown: true, calls: both('gdbus') })
  assert.deepEqual(await probe({ gdbus: '(false,)\n' }), { shown: false, calls: [{ command: 'gdbus', timeout: 1000 }] })
  const viaDbusSend = await probe({
    'dbus-send': 'method return time=1.2 sender=org.freedesktop.DBus\n   boolean true\n',
    'dbus-send host': 'method return time=1.3 sender=:1.40\n   variant       boolean true\n',
  })
  assert.deepEqual(viaDbusSend, { shown: true, calls: [{ command: 'gdbus', timeout: 1000 }, ...both('dbus-send')] })
  assert.equal((await probe({ 'dbus-send': '   boolean false\n' })).shown, false)
  assert.equal((await probe({})).shown, false, 'no bus or no tool: treated as no tray')
  // A watcher with no host registered draws no icon: Electron's falls back to a GTK one, shown nowhere.
  assert.deepEqual(await probe({ gdbus: '(true,)\n', 'gdbus host': '(<false>,)\n' }), { shown: false, calls: both('gdbus') })
  assert.equal((await probe({ 'dbus-send': '   boolean true\n', 'dbus-send host': '   variant       boolean false\n' })).shown, false)
  assert.equal((await probe({ gdbus: '(true,)\n', 'gdbus host': new Error('No such property') })).shown, false, 'nor one that cannot say')
  // Both ask the bus itself whether the watcher's name has an owner, then the watcher whether a host registered.
  for (const [, [watcher, host]] of STATUS_NOTIFIER_PROBES) {
    assert.ok(watcher.some((a) => a.endsWith('NameHasOwner')) && watcher.some((a) => a.endsWith('org.kde.StatusNotifierWatcher')))
    assert.ok(host.some((a) => a.endsWith('Properties.Get')) && host.some((a) => a.endsWith('IsStatusNotifierHostRegistered')))
  }
})

// With no DBUS_SESSION_BUS_ADDRESS (a session started without one, an app launched from a bare shell) gdbus and
// dbus-send look for a bus themselves and, with an X display, autolaunch one (`dbus-launch --autolaunch`): a bus no
// tray registers with, which outlives the probe. The user's bus socket is given to them when it exists; else neither
// runs, and the desktop counts as showing no tray. Linux only, as the probe is (main.js asks only there): the test
// listens on a unix socket path, which Windows refuses (EACCES).
test('probeStatusNotifierHost: with no bus address, the user\'s bus socket if it exists, else no tray and no tool run', { skip: process.platform === 'win32' && 'unix socket paths; the probe runs on Linux only' }, async (t) => {
  const runtime = mkdtempSync(join(tmpdir(), 'tllm-xdg-'))
  const server = createServer()
  t.after(() => {
    server.close()
    rmSync(runtime, { recursive: true, force: true })
  })
  const probe = async (env) => {
    const { execFile, calls } = fakeExecFile({ gdbus: '(true,)\n', 'gdbus host': '(<true>,)\n' })
    return { shown: await probeStatusNotifierHost({ execFile, timeoutMs: 1000, env }), buses: calls.map((c) => c.bus) }
  }
  assert.deepEqual(await probe({ XDG_RUNTIME_DIR: runtime }), { shown: false, buses: [] }, 'no socket: nothing runs')
  writeFileSync(join(runtime, 'bus'), '')
  assert.deepEqual(await probe({ XDG_RUNTIME_DIR: runtime }), { shown: false, buses: [] }, 'a file that is no socket: nothing runs')
  rmSync(join(runtime, 'bus'))
  assert.deepEqual(await probe({}), { shown: false, buses: [] }, 'no runtime folder: nothing runs')
  assert.deepEqual(await probe({ XDG_RUNTIME_DIR: 'run/user/1000' }), { shown: false, buses: [] }, 'a relative one is none')

  await new Promise((resolve) => server.listen(join(runtime, 'bus'), resolve))
  assert.deepEqual(await probe({ XDG_RUNTIME_DIR: runtime }), { shown: true, buses: Array(2).fill(`unix:path=${join(runtime, 'bus')}`) })
  // An address set is the one used, socket or not.
  assert.deepEqual(await probe({ XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=x' }), { shown: true, buses: ['unix:abstract=x', 'unix:abstract=x'] })
  assert.equal(sessionBusAddress({ XDG_RUNTIME_DIR: '/run/user/1 000' }, () => true), 'unix:path=/run/user/1%20000/bus', 'escaped as D-Bus addresses are')
})

test('closeAction: with no tray icon a close closes the window and the app quits, as before', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(closeAction({ platform, quitting: false, hasTray: false }), 'close', platform)
    assert.equal(quitsWhenAllClosed({ platform, hasTray: false }), true, platform)
  }
})

test('openAction: a second launch, the tray or the Dock shows the open window, and opens one only when there is none', () => {
  const up = { quitting: false, refused: false, daemonReady: true }
  assert.equal(openAction({ ...up, hasWindow: true }), 'show', 'hidden, minimized or behind: shown, never duplicated')
  assert.equal(openAction({ ...up, hasWindow: false }), 'create', 'closed (macOS): a new window')
})

test('openAction: nothing opens while the daemon starts, after it was refused, or during a quit', () => {
  for (const hasWindow of [true, false]) {
    assert.equal(openAction({ quitting: false, refused: false, daemonReady: false, hasWindow }), 'none', 'the startup window opens on its own')
    assert.equal(openAction({ quitting: false, refused: true, daemonReady: true, hasWindow }), 'none', 'refused: the dialog quits the app')
    assert.equal(openAction({ quitting: true, refused: false, daemonReady: true, hasWindow }), 'none', 'quitting')
  }
})

test('trayMenuTemplate: Open TurboLLM opens the window, Quit TurboLLM quits the app', () => {
  const calls = []
  const menu = trayMenuTemplate({ open: () => calls.push('open'), quit: () => calls.push('quit') })

  assert.deepEqual(menu.map((item) => item.label || item.type), ['Open TurboLLM', 'separator', 'Quit TurboLLM'])
  menu[0].click({}, undefined, {}) // what Electron passes a click handler (menuItem, window, event)
  assert.deepEqual(calls, ['open'])
  menu[2].click({}, undefined, {})
  assert.deepEqual(calls, ['open', 'quit'])
})

test('the tray notice says the app still runs and where Quit is', () => {
  assert.deepEqual(TRAY_NOTICE, { title: 'TurboLLM', body: 'TurboLLM is still running. Quit it from the tray icon.' })
})

test('createTrayNotice: the notice is due once, and later launches never show it again', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-tray-notice-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, TRAY_NOTICE_FILE)

  const notice = createTrayNotice(file)
  assert.equal(notice.take(), true, 'the first close to the tray')
  assert.equal(notice.take(), false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { shown: true })
  assert.equal(createTrayNotice(file).take(), false, 'the next launch')
})

test('createTrayNotice: a missing folder is created; a corrupt or foreign file reads as not shown yet', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-tray-notice-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const nested = join(dir, 'not-yet', TRAY_NOTICE_FILE)
  assert.equal(createTrayNotice(nested).take(), true)
  assert.equal(createTrayNotice(nested).take(), false)

  for (const content of ['{not json', 'null', '{"shown":"yes"}', '{}']) {
    const file = join(dir, TRAY_NOTICE_FILE)
    writeFileSync(file, content)
    assert.equal(createTrayNotice(file).take(), true, content)
  }
})

test('createTrayNotice: a write that fails still shows the notice only once per launch', () => {
  const writes = []
  const failingFs = {
    readFileSync () { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    mkdirSync () {},
    writeFileSync (file) { writes.push(file); throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }) },
  }
  const error = console.error
  console.error = () => {}
  try {
    const notice = createTrayNotice('/ro/tray-notice.json', failingFs)
    assert.equal(notice.take(), true)
    assert.equal(notice.take(), false)
    assert.deepEqual(writes, ['/ro/tray-notice.json'], 'written once')
  } finally {
    console.error = error
  }
})
