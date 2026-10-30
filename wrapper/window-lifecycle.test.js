// window-lifecycle.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const {
  TRAY_NOTICE, TRAY_NOTICE_FILE, closeAction, createTrayNotice, openAction, quitsWhenAllClosed, trayMenuTemplate, usesTray,
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
