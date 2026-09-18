import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sgLangServeBlocker, classifySglangBlocker } from './sglang'

test('classifySglangBlocker: Windows and macOS report an unsupported platform', () => {
  assert.match(classifySglangBlocker('win32', new Error('boom')), /SGLang cannot run on Windows/)
  assert.match(classifySglangBlocker('darwin', new Error('boom')), /SGLang cannot run on macOS/)
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

test('sgLangServeBlocker returns a clear message when the runtime cannot serve', async () => {
  const msg = await sgLangServeBlocker(process.platform === 'win32' ? 'C:/no/such/python.exe' : '/no/such/python')
  assert.ok(msg)
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.match(msg!, /cannot run on/i)
  } else {
    assert.doesNotMatch(msg!, /cannot run on/i)
  }
})
