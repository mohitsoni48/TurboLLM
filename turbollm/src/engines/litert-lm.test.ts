import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  androidWheelAbi,
  classifyLitertLmBlocker,
  ensureLitertLmEnv,
  isLitertLmProbeInconclusive,
  litertLmConfigPath,
  litertLmEnvFingerprint,
  litertLmLoadFailureMessage,
  litertLmPathBlocker,
  litertLmPrefillStats,
  litertLmProfileToConfig,
  litertLmServeBlocker,
  litertLmServeBlockerCached,
  litertLmServerCommand,
  pickAndroidWheel,
  resetLitertLmServeCache,
  warmUpLitertLm,
  writeLitertLmConfig,
} from './litert-lm'
import { tmpDir } from '../test-support/tmp'

test('litertLmProfileToConfig: Auto writes no backend, so the server runs the model on its own', () => {
  // Auto used to be the GPU whenever one was detected and the llama.cpp GPU-layers default was above 0, and the CPU
  // otherwise: the Android app put a CPU-only bundle on the GPU, and a GPU-only bundle went to the CPU elsewhere.
  assert.equal('backend' in litertLmProfileToConfig({ ctx: 4096, threads: 0 }).default, false)
  assert.equal('backend' in litertLmProfileToConfig({ ctx: 4096, threads: 0, litertLm: { backend: 'auto' } }).default, false)
})

test('litertLmProfileToConfig: ctx becomes max_num_tokens and threads becomes cpu_thread_count only when set', () => {
  assert.deepEqual(litertLmProfileToConfig({ ctx: 8192, threads: 6, litertLm: { backend: 'cpu' } }), {
    default: { backend: 'cpu', max_num_tokens: 8192, cpu_thread_count: 6 },
  })
  const auto = litertLmProfileToConfig({ ctx: 0, threads: 0 })
  assert.deepEqual(auto, { default: {} })
  assert.ok(!('cpu_thread_count' in auto.default))
  assert.ok(!('max_num_tokens' in auto.default))
})

test('litertLmPathBlocker: a comma anywhere in the path is refused, a clean path is not', () => {
  assert.match(litertLmPathBlocker('/models/a,b/model.litertlm') ?? '', /comma/)
  assert.match(litertLmPathBlocker('/models/model,v2.litertlm') ?? '', /comma/)
  assert.equal(litertLmPathBlocker('/models/my model (v2)/model.litertlm'), null)
})

test('litertLmServerCommand: runs the CLI as a module with an explicit config, host and port, extra args last', () => {
  assert.deepEqual(litertLmServerCommand('/venv/bin/python', '/data/cfg.json', 8085, '127.0.0.1', ['--verbose']), {
    cmd: '/venv/bin/python',
    args: ['-m', 'litert_lm_cli.main', 'serve', '--config', '/data/cfg.json', '--host', '127.0.0.1', '--port', '8085', '--verbose'],
  })
  assert.deepEqual(litertLmServerCommand('py', 'c.json', 1, 'h').args.slice(-2), ['--port', '1'])
})

test('the config file is per port and round-trips what was written', (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-cfg-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = litertLmConfigPath(dir, 8081)
  const b = litertLmConfigPath(dir, 8082)
  assert.notEqual(a, b)
  assert.equal(a, join(dir, 'engines', 'litert-lm', 'config-8081.json'))
  writeLitertLmConfig(a, { default: { backend: 'gpu', max_num_tokens: 2048 } })
  writeLitertLmConfig(b, { default: { backend: 'cpu' } })
  assert.deepEqual(JSON.parse(readFileSync(a, 'utf8')), { default: { backend: 'gpu', max_num_tokens: 2048 } })
  assert.deepEqual(JSON.parse(readFileSync(b, 'utf8')), { default: { backend: 'cpu' } })
  assert.ok(existsSync(a) && existsSync(b))
})

test('classifyLitertLmBlocker: an unsupported platform/arch is named as having no build', () => {
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['freebsd', 'x64'], ['android', 'arm'], ['android', 'ia32']] as const) {
    assert.match(classifyLitertLmBlocker(platform, arch, new Error('x')), /only for Windows x64, Linux x64\/arm64, macOS on Apple Silicon and Android/)
  }
})

test('classifyLitertLmBlocker: a supported platform reports a load failure with the last stderr line, capped', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['android', 'arm64'], ['android', 'x64']] as const) {
    const msg = classifyLitertLmBlocker(platform, arch, new Error('Traceback\r\nImportError: libc too old'))
    assert.doesNotMatch(msg, /no build/)
    assert.match(msg, /ImportError: libc too old/)
    assert.match(msg, platform === 'android' ? /API 23.*Termux/ : /glibc 2\.27/)
  }
  const long = classifyLitertLmBlocker('linux', 'x64', new Error('E: ' + 'x'.repeat(5000)))
  assert.ok(long.length < 600)
})

test('litertLmLoadFailureMessage: the GPU hint names the Backend control, which is the one the LiteRT-LM panel actually offers', () => {
  // "Set GPU layers to 0" is llama.cpp advice — that slider is not rendered for LiteRT-LM
  // (PR #271 review), so the hint must point at the real recovery path: Backend → Auto or CPU.
  assert.match(litertLmLoadFailureMessage('boom', 'gpu'), /set Backend to Auto \(the model's own\) or CPU/)
  assert.doesNotMatch(litertLmLoadFailureMessage('boom', 'gpu'), /GPU layers/)
  assert.match(litertLmLoadFailureMessage('boom', 'cpu'), /complete \.litertlm bundle/)
  assert.match(litertLmLoadFailureMessage('boom', 'cpu'), /— boom\./)
})

test('litertLmLoadFailureMessage: the GPU is named only when the user chose it', () => {
  // An LFM2.5-230M load that failed in its data processor under Auto was told to switch to CPU.
  const lfm2 = 'RuntimeError: Failed to create conversation: FAILED_PRECONDITION: Constrained decoding is not supported for Lfm2DataProcessor.'
  const auto = litertLmLoadFailureMessage(lfm2, 'auto')
  assert.doesNotMatch(auto, /GPU|switch the Backend|CPU/)
  assert.match(auto, new RegExp(`— ${lfm2.replace(/[.()]/g, '\\$&')}\\.`))
  assert.match(litertLmLoadFailureMessage(lfm2, 'gpu'), /You chose the GPU backend/)
  // A CPU the bundle excludes (the runtime's constraint message) points back to the model's own backend.
  const mismatch = 'INVALID_ARGUMENT: Main backend constraint mismatch. Model requires one of [gpu] but Main backend is CPU'
  assert.match(litertLmLoadFailureMessage(mismatch, 'cpu'), /You chose the CPU backend, which this model does not support: set Backend to Auto/)
  assert.doesNotMatch(litertLmLoadFailureMessage(mismatch, 'auto'), /You chose/)
})

// ── warm-up against a local stand-in for `litert-lm serve` ───────────────────
function fakeServe(t: TestContext, status: number, statusText: string, seen: { body?: Record<string, unknown> }): Promise<number> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seen.body = JSON.parse(raw || '{}')
        res.statusMessage = statusText
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    t.after(() => { server.close() })
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

test('warmUpLitertLm: a 200 means the model loaded; it asks for exactly one token via max_completion_tokens', async (t) => {
  const seen: { body?: Record<string, unknown> } = {}
  const port = await fakeServe(t, 200, 'OK', seen)
  const res = await warmUpLitertLm(port, '/models/m.litertlm', AbortSignal.timeout(5000))
  assert.deepEqual(res, { ok: true })
  assert.equal(seen.body?.model, '/models/m.litertlm')
  assert.equal(seen.body?.max_completion_tokens, 1)
  assert.equal('max_tokens' in (seen.body ?? {}), false)
  assert.equal(seen.body?.stream, false)
})

test('warmUpLitertLm: a 500 returns the runtime message carried in the status text', async (t) => {
  const port = await fakeServe(t, 500, 'Failed to load engine: RuntimeError(bad bundle)', {})
  const res = await warmUpLitertLm(port, '/m.litertlm', AbortSignal.timeout(5000))
  assert.equal(res.ok, false)
  assert.match((res as { message: string }).message, /Failed to load engine: RuntimeError\(bad bundle\)/)
})

test('warmUpLitertLm: nothing listening is reported as a failure, not thrown', async () => {
  const res = await warmUpLitertLm(1, '/m.litertlm', AbortSignal.timeout(2000))
  assert.equal(res.ok, false)
})

test('androidWheelAbi maps Node arch names to the wheel platform tag', () => {
  assert.equal(androidWheelAbi('arm64'), 'arm64_v8a')
  assert.equal(androidWheelAbi('x64'), 'x86_64')
  assert.equal(androidWheelAbi('arm'), null)
  assert.equal(androidWheelAbi('ia32'), null)
})

test('pickAndroidWheel selects the matching Android ABI and ignores desktop wheels', () => {
  const f = (filename: string) => ({ filename, url: `https://files/${filename}`, digests: { sha256: 'ab'.repeat(32) } })
  const files = [
    f('litert_lm_api-0.17.1-py3-none-android_23_arm64_v8a.whl'),
    f('litert_lm_api-0.17.1-py3-none-android_23_x86_64.whl'),
    f('litert_lm_api-0.17.1-py3-none-manylinux_2_27_aarch64.whl'),
    f('litert_lm_api-0.17.1-py3-none-win_amd64.whl'),
  ]
  assert.equal(pickAndroidWheel(files, 'arm64_v8a')?.filename, 'litert_lm_api-0.17.1-py3-none-android_23_arm64_v8a.whl')
  assert.equal(pickAndroidWheel(files, 'x86_64')?.filename, 'litert_lm_api-0.17.1-py3-none-android_23_x86_64.whl')
  assert.equal(pickAndroidWheel(files.slice(2), 'arm64_v8a'), null)
})

// v1.14.5 review: this is the one install path that unpacks a downloaded archive by hand, so it takes
// nothing it cannot verify: no digest means no integrity check, and a name with a path separator would
// be joined into a write path.
test('pickAndroidWheel skips a wheel PyPI lists without a SHA-256 digest, or with a path in its name', () => {
  const sha = { sha256: 'ab'.repeat(32) }
  assert.equal(pickAndroidWheel([{ filename: 'x-1-py3-none-android_23_arm64_v8a.whl', url: 'u' }], 'arm64_v8a'), null, 'no digest')
  assert.equal(pickAndroidWheel([{ filename: '../x-1-py3-none-android_23_arm64_v8a.whl', url: 'u', digests: sha }], 'arm64_v8a'), null, 'POSIX separator')
  assert.equal(pickAndroidWheel([{ filename: '..\\x-1-py3-none-android_23_arm64_v8a.whl', url: 'u', digests: sha }], 'arm64_v8a'), null, 'Windows separator')
})

test('pickAndroidWheel prefers the highest API level when several are published', () => {
  const f = (filename: string) => ({ filename, url: 'u', digests: { sha256: 'ab'.repeat(32) } })
  const picked = pickAndroidWheel(
    [f('x-1-py3-none-android_21_arm64_v8a.whl'), f('x-1-py3-none-android_24_arm64_v8a.whl'), f('x-1-py3-none-android_9_arm64_v8a.whl')],
    'arm64_v8a',
  )
  assert.equal(picked?.filename, 'x-1-py3-none-android_24_arm64_v8a.whl')
})

// ── the native-load preflight, against a stand-in `litert_lm` package on PYTHONPATH ──────────
const HAS_PYTHON = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()

async function blockerWithFfi(t: TestContext, ffiSource: string): Promise<string | null> {
  const dir = tmpDir('turbollm-litert-probe-')
  const before = process.env.PYTHONPATH
  t.after(() => {
    if (before === undefined) delete process.env.PYTHONPATH
    else process.env.PYTHONPATH = before
    rmSync(dir, { recursive: true, force: true })
  })
  mkdirSync(join(dir, 'litert_lm'))
  writeFileSync(join(dir, 'litert_lm', '__init__.py'), '')
  writeFileSync(join(dir, 'litert_lm', '_ffi.py'), ffiSource)
  process.env.PYTHONPATH = dir
  return litertLmServeBlocker('python3')
}

test('litertLmServeBlocker: passes when the native library loads', { skip: !HAS_PYTHON }, async (t) => {
  assert.equal(await blockerWithFfi(t, 'def _get_lib():\n    return object()\n'), null)
})

test('litertLmServeBlocker: reports a native library that will not load, which a bare import would miss', { skip: !HAS_PYTHON }, async (t) => {
  const msg = await blockerWithFfi(t, 'def _get_lib():\n    raise OSError("liblitert-lm.so: wrong ELF class")\n')
  assert.match(msg ?? '', /native runtime could not load/)
  assert.match(msg ?? '', /wrong ELF class/)
})

test('litertLmServeBlocker: a future version without _get_lib degrades to the plain import, not a false failure', { skip: !HAS_PYTHON }, async (t) => {
  assert.equal(await blockerWithFfi(t, '# no _get_lib here\n'), null)
})

// ── the cached serve preflight (PR #271 review: the probe spawns a Python process and dlopens
// the native library on EVERY load/auto-resume — noticeable on a phone — so it is cached per
// interpreter + installed-package mtime and only re-run after the environment changes) ──

test('litertLmEnvFingerprint: stable for an unchanged venv, invalidated by a reinstall', (t: TestContext) => {
  const env = tmpDir('turbollm-litert-fp-')
  t.after(() => rmSync(env, { recursive: true, force: true }))
  // The venv layout differs per OS (Scripts\python.exe + Lib\site-packages on Windows), and the
  // fingerprint reads the real one — a POSIX-only fixture never changed on Windows (v1.14.5 review).
  const win = process.platform === 'win32'
  const py = win ? join(env, 'Scripts', 'python.exe') : join(env, 'bin', 'python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, '')
  const pkg = win ? join(env, 'Lib', 'site-packages', 'litert_lm') : join(env, 'lib', 'python3.12', 'site-packages', 'litert_lm')
  mkdirSync(pkg, { recursive: true })

  const before = litertLmEnvFingerprint(py)
  assert.ok(before, 'a real path yields a fingerprint')
  assert.equal(litertLmEnvFingerprint(py), before, 'unchanged environment → the same fingerprint')

  // A reinstall rewrites the package dir (pip replaces it wholesale) → new fingerprint.
  const later = new Date(Date.now() + 2000)
  utimesSync(pkg, later, later)
  assert.notEqual(litertLmEnvFingerprint(py), before, 'a touched package dir must invalidate the cache key')

  assert.equal(litertLmEnvFingerprint(join(dirname(py), 'no-such-python')), null, 'a missing interpreter cannot be fingerprinted')
})

/** A stand-in interpreter that appends "run" to `runs` each time it starts, then exits with `code`. */
function fakePython(dir: string, runs: string, code: number): string {
  const py = join(dir, 'bin', 'fake-python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, `#!/bin/sh\necho run >> "${runs}"\nexit ${code}\n`)
  chmodSync(py, 0o755)
  return py
}

// v1.14.5 review: a failure is often fixed OUTSIDE the venv (Defender done scanning a fresh DLL, the
// VC++ runtime installed, a newer glibc), which no fingerprint sees — so a cached failure outlived the
// fix until the daemon restarted. Only a pass is cached; a failure costs one probe per load.
test('litertLmServeBlockerCached: a failing probe is never cached, so the next load checks again', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-cache-fail-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runs = join(dir, 'runs')
  const py = fakePython(dir, runs, 1)

  assert.ok(await litertLmServeBlockerCached(py), 'the failing interpreter must yield a blocker message')
  await litertLmServeBlockerCached(py)
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run\nrun', 'a failure must be re-probed, not served from the cache')
})

test('litertLmServeBlockerCached: a passing probe runs once per environment, and again after the environment changes', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-cache-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runs = join(dir, 'runs')
  const py = fakePython(dir, runs, 0)

  assert.equal(await litertLmServeBlockerCached(py), null)
  assert.equal(await litertLmServeBlockerCached(py), null)
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run', 'the probe must run exactly once for an unchanged environment')

  // Touching the interpreter changes the fingerprint → the probe re-runs.
  const later = new Date(Date.now() + 2000)
  utimesSync(py, later, later)
  await litertLmServeBlockerCached(py)
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run\nrun', 'a changed environment must re-probe')
})

// ── a probe that times out answered nothing (PR #271 re-review): execFile's timeout SIGTERMs the
// child, which litertLmServeBlocker used to classify into a blocker message — and the cache kept
// it, so one slow probe on a busy phone became "native runtime could not load" for every later
// load until the daemon restarted or the engine was reinstalled ──

test('isLitertLmProbeInconclusive: kills and timeouts answered nothing; a real exit did', () => {
  assert.equal(isLitertLmProbeInconclusive({ killed: true, signal: 'SIGTERM', code: null }), true, 'execFile timeout kill')
  assert.equal(isLitertLmProbeInconclusive({ killed: false, signal: 'SIGKILL', code: null }), true, 'killed by a signal')
  assert.equal(isLitertLmProbeInconclusive({ killed: false, signal: null, code: 'ETIMEDOUT' }), true, 'spawn ETIMEDOUT')
  assert.equal(isLitertLmProbeInconclusive({ killed: false, signal: null, code: 1 }), false, 'a non-zero exit is a real verdict')
  // A native library that crashes on load (a bad instruction on an older CPU, a segfault) is a real
  // answer about this machine, not a sign it was busy.
  assert.equal(isLitertLmProbeInconclusive({ killed: false, signal: 'SIGSEGV', code: null }), false, 'a crash on load')
  assert.equal(isLitertLmProbeInconclusive({ killed: false, signal: 'SIGILL', code: null }), false, 'an unsupported instruction')
  assert.equal(isLitertLmProbeInconclusive(new Error('command not found')), false)
})

test('litertLmServeBlockerCached: a timed-out probe is answered for that load but never cached', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-slowprobe-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A stand-in interpreter that records each run, then outlives the injected probe budget
  // (1 s instead of the 60 s production one). `exec sleep` so the killed process IS sleep — no
  // orphan shell left waiting on it.
  const runs = join(dir, 'runs')
  const py = join(dir, 'bin', 'fake-python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, `#!/bin/sh\necho run >> "${runs}"\nexec sleep 30\n`)
  chmodSync(py, 0o755)

  const first = await litertLmServeBlockerCached(py, undefined, 1_000)
  assert.match(first ?? '', /did not finish/, 'the honest no-answer message, not "could not load"')
  assert.doesNotMatch(first ?? '', /could not load/, 'a timeout must not be reported as a broken runtime')
  const second = await litertLmServeBlockerCached(py, undefined, 1_000)
  assert.match(second ?? '', /did not finish/)
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run\nrun', 'the timed-out probe must be re-run, not served from the cache')
})

// A native crash leaves stderr empty, and Node's error message ends with the probe's own source, so the
// "detail" used to be a line of Python like `load() if callable(load) else None` (v1.14.5 fix-delta review).
test('litertLmServeBlocker: a native crash names the signal, not a line of the probe', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-crash-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const py = join(dir, 'bin', 'fake-python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, '#!/bin/sh\nkill -ILL $$\n')
  chmodSync(py, 0o755)
  const msg = await litertLmServeBlocker(py)
  assert.match(msg ?? '', /could not load/)
  assert.match(msg ?? '', /crashed \(SIGILL\)/)
  assert.doesNotMatch(msg ?? '', /callable/)
})

test('litertLmServeBlocker: a timed-out probe reports the timeout, not a broken native runtime', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-slowprobe-plain-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const py = join(dir, 'bin', 'fake-python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, '#!/bin/sh\nexec sleep 30\n')
  chmodSync(py, 0o755)
  const msg = await litertLmServeBlocker(py, undefined, 1_000)
  assert.match(msg ?? '', /did not finish/)
  assert.doesNotMatch(msg ?? '', /could not load/)
})

// ── the cache must not survive a reinstall (PR #271 re-review) ──
// The Android provision unpacks the native wheel with `zipfile -e` OVER the old files: every
// file inside litert_lm/ is rewritten, but no directory entry is added or removed — and a
// directory's mtime (the fingerprint's key) only changes when entries come and go. The
// fingerprint therefore CANNOT see an in-place reinstall, so ensureLitertLmEnv clears the
// cache in a finally instead. These tests lock both halves of that reasoning.

test('litertLmEnvFingerprint: an in-place file rewrite (the zipfile -e reinstall shape) does not change the key', (t: TestContext) => {
  const env = tmpDir('turbollm-litert-fp-inplace-')
  t.after(() => rmSync(env, { recursive: true, force: true }))
  const py = join(env, 'bin', 'python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, '')
  const pkg = join(env, 'lib', 'python3.12', 'site-packages', 'litert_lm')
  mkdirSync(join(pkg, 'native'), { recursive: true })
  const so = join(pkg, 'native', 'liblitert-lm.so')
  writeFileSync(so, 'old-bytes')

  const before = litertLmEnvFingerprint(py)
  // The reinstall shape: same entry set, new file CONTENT and mtime.
  const later = new Date(Date.now() + 5000)
  utimesSync(so, later, later)
  assert.equal(litertLmEnvFingerprint(py), before, 'an overwritten-in-place file is invisible to the key — hence resetLitertLmServeCache')
})

test('litertLmServeBlockerCached: resetLitertLmServeCache drops the answer so the next load re-probes', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const dir = tmpDir('turbollm-litert-cachereset-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runs = join(dir, 'runs')
  // A PASSING stand-in (v1.14.5 semantics — carried into this PR's merge — cache only a
  // pass; a failure is dropped the moment it lands), so there is a cached verdict for the
  // reset to drop.
  const py = join(dir, 'bin', 'fake-python')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, `#!/bin/sh\necho run >> "${runs}"\nexit 0\n`)
  chmodSync(py, 0o755)

  const first = await litertLmServeBlockerCached(py)
  assert.equal(first, null, 'a passing interpreter yields no blocker')
  assert.equal(await litertLmServeBlockerCached(py), first, 'and it is served from the cache')
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run', 'one probe so far')

  // A provision finished (ensureLitertLmEnv's finally) — the next load must re-measure the
  // new files, not replay the verdict about the old ones.
  resetLitertLmServeCache()
  await litertLmServeBlockerCached(py)
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run\nrun', 'the probe re-ran after the reset')
})

test('litertLmPrefillStats: prompt tokens over time-to-first-token, rounded to one decimal', () => {
  assert.deepEqual(litertLmPrefillStats(300, 1500), { promptMs: 1500, promptTps: 200 })
  assert.deepEqual(litertLmPrefillStats(100, 3000), { promptMs: 3000, promptTps: 33.3 })
})

test('litertLmPrefillStats: no usage or no TTFT yields nothing rather than a made-up number', () => {
  assert.equal(litertLmPrefillStats(undefined, 1000), null)
  assert.equal(litertLmPrefillStats(0, 1000), null)
  assert.equal(litertLmPrefillStats(100, 0), null)
  assert.equal(litertLmPrefillStats(100, Number.NaN), null)
})

test('litertLmProfileToConfig: an explicit backend reaches the server as it is', () => {
  const p = (backend: 'auto' | 'cpu' | 'gpu') => ({ ctx: 4096, threads: 0, litertLm: { backend } })
  assert.equal(litertLmProfileToConfig(p('gpu')).default.backend, 'gpu', 'forced GPU, whatever was detected (Android)')
  assert.equal(litertLmProfileToConfig(p('cpu')).default.backend, 'cpu', 'forced CPU on a GPU machine')
  assert.equal(litertLmProfileToConfig(p('auto')).default.backend, undefined)
})

// ── ensureLitertLmEnv itself must be the one to reset the cache (PR #271 follow-up): the
// reset tests above prove resetLitertLmServeCache() drops a cached verdict, but nothing
// called the provision — remove the finally inside ensureLitertLmEnv and every suite stayed
// green. This locks the call in, with a provision that fails at the install step so nothing
// is downloaded: the venv interpreter and its fingerprint are untouched by the failure, so
// ONLY the finally's reset can explain the re-probe. ──

test('ensureLitertLmEnv: a provision that fails still drops every cached serve verdict', { skip: process.platform === 'win32' }, async (t: TestContext) => {
  const root = tmpDir('turbollm-litert-ensurefail-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A stand-in venv interpreter (present, so the provision skips venv creation and dies at
  // the install step — the exact moment a cancelled provision leaves a half-installed venv)
  // whose PASSING probe verdict gets cached (v1.14.5 caches only passes, so a pass is the
  // verdict the provision's finally must drop), plus a failing stand-in uv. Neither touches
  // the network.
  const py = join(root, 'litert-lm', 'venv', 'bin', 'python')
  const runs = join(root, 'runs')
  mkdirSync(dirname(py), { recursive: true })
  writeFileSync(py, `#!/bin/sh\necho run >> "${runs}"\nexit 0\n`)
  chmodSync(py, 0o755)
  mkdirSync(join(root, 'uv'), { recursive: true })
  writeFileSync(join(root, 'uv', 'uv'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(root, 'uv', 'uv'), 0o755)

  const first = await litertLmServeBlockerCached(py)
  assert.equal(first, null, 'the passing interpreter yields no blocker')
  assert.equal(await litertLmServeBlockerCached(py), first, 'and it is cached')
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run', 'one probe so far')

  await assert.rejects(ensureLitertLmEnv(root))
  await litertLmServeBlockerCached(py)
  assert.equal(readFileSync(runs, 'utf8').trim(), 'run\nrun', 'the failed provision must have dropped the cached verdict')
})
