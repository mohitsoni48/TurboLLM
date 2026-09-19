import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { sgLangServeBlocker, classifySglangBlocker } from './sglang'
import { classifyVllmBlocker } from './vllm'

test('classifySglangBlocker: Windows reports an unsupported platform', () => {
  assert.match(classifySglangBlocker('win32', new Error('boom')), /SGLang cannot run on Windows/)
})

test('classifySglangBlocker: macOS reports a broken environment — uvloop ships macOS wheels, but SGLang is unsupported upstream there', () => {
  const msg = classifySglangBlocker('darwin', new Error('ModuleNotFoundError: no module named uvloop'))
  assert.doesNotMatch(msg, /cannot run on/i)
  // The catalog says SGLang on macOS is unsupported upstream: only uvloop's own support may be asserted.
  assert.doesNotMatch(msg, /macOS is a supported platform/i)
  assert.match(msg, /uvloop itself supports macOS/)
  assert.match(msg, /reinstall/i)
})

test('classifySglangBlocker: Linux, where SGLang is officially supported, still says so', () => {
  const msg = classifySglangBlocker('linux', new Error('ModuleNotFoundError: no module named uvloop'))
  assert.match(msg, /Linux is a supported platform for SGLang/)
})

test('classifySglangBlocker: an unverified platform is never claimed as supported', () => {
  const msg = classifySglangBlocker('openbsd', new Error('ModuleNotFoundError: no module named uvloop'))
  assert.doesNotMatch(msg, /supported platform/i)
  assert.match(msg, /unverified/i)
  assert.match(msg, /reinstall/i)
})

test('classifySglangBlocker: Linux reports a broken environment, never "no Linux build" (regression)', () => {
  // uvloop ships real manylinux wheels — a Linux import failure is an environment problem
  // (broken/incomplete venv), never a platform limitation. Mirrors the vLLM fix (ADR-080)
  // since sglang.ts explicitly copies vLLM's uvloop preflight.
  const msg = classifySglangBlocker('linux', new Error('ModuleNotFoundError: no module named uvloop'))
  assert.doesNotMatch(msg, /cannot run on/i)
  assert.match(msg, /reinstall/i)
})

test('classifySglangBlocker: a missing interpreter (ENOENT) is a broken install, not an unsupported platform', () => {
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
  assert.match(classifySglangBlocker('linux', enoent), /interpreter not found/i)
})

test('classifySglangBlocker: CRLF stderr, a capped detail and a redacted home directory', () => {
  const home = homedir()
  const slashed = home.split('\\').join('/')
  const stderr = `Traceback:\r\nImportError: ${slashed}/.turbollm ${'x'.repeat(5000)}\r\n`
  const msg = classifySglangBlocker('linux', Object.assign(new Error('exit 1'), { stderr }))
  assert.doesNotMatch(msg, /\r/)
  assert.ok(!msg.includes(slashed), 'home directory leaked')
  assert.ok(msg.length < 500, `message was ${msg.length} chars`)
  assert.match(msg, /…\)/)
})

test('vLLM and SGLang share one blocker classifier — only the engine name differs', () => {
  const platforms: NodeJS.Platform[] = ['win32', 'darwin', 'linux', 'freebsd']
  const errors: unknown[] = [
    new Error('ModuleNotFoundError: no module named uvloop'),
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('exit 1'), { stderr: 'ImportError: libcuda.so.1\n' }),
  ]
  for (const platform of platforms) {
    for (const error of errors) {
      const sglang = classifySglangBlocker(platform, error).split('SGLang').join('<engine>')
      const vllm = classifyVllmBlocker(platform, error).split('vLLM').join('<engine>')
      assert.equal(sglang, vllm)
    }
  }
})

test('sgLangServeBlocker returns a clear message when the runtime cannot serve', async () => {
  const msg = await sgLangServeBlocker(process.platform === 'win32' ? 'C:/no/such/python.exe' : '/no/such/python')
  assert.ok(msg)
  if (process.platform === 'win32') {
    assert.match(msg!, /cannot run on/i)
  } else {
    assert.doesNotMatch(msg!, /cannot run on/i)
  }
})
