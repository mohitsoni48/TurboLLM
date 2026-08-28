// Tests for the pi-search bootstrap: ensurePiSearchPackage + piSearchPackagePresent, and
// launchCli's use of it.
//
// `turbollm launch pi` points a STANDALONE `pi` at the daemon over the OpenAI `/v1` API, where pi
// declares its own toolset and nothing can inject tools into it — so the only way a launched pi gets
// web search is if the package is ALREADY present on the pi side. ensurePiSearchPackage runs
// `pi install npm:@heyhuynhgiabuu/pi-search` BEST-EFFORT, but ONLY ONCE per machine: it first reads
// the user's `~/.pi/agent/settings.json` (a fast, offline-free local read) and skips the ~3 s npm
// call when the package is already listed. A failure must NEVER break the launch.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { launchCli, ensurePiSearchPackage, piSearchPackagePresent, runWithTimeout, type ConfigFs, type RunCommand } from './cli-launch.js'

const HOME = '/home/tester'
const SPEC = '@heyhuynhgiabuu/pi-search@0.3.0'
const ENTRY = `npm:${SPEC}`
const SETTINGS = join(HOME, '.pi', 'agent', 'settings.json')

/** In-memory ConfigFs — mirrors cli-launch.config.test.ts's own memFs helper exactly. */
function memFs(seed: Record<string, string> = {}): ConfigFs & { files: Map<string, string>; mkdirs: string[] } {
  const files = new Map<string, string>(Object.entries(seed))
  const mkdirs: string[] = []
  return {
    files,
    mkdirs,
    home: HOME,
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)!
    },
    writeFile: async (p: string, data: string) => { files.set(p, data) },
    mkdir: async (p: string) => { mkdirs.push(p) },
  }
}

/** A settings.json whose `packages` array contains the given entry specs. */
function settingsWithPackages(...packages: string[]): string {
  return JSON.stringify({ defaultProvider: 'turbollm', packages })
}

/** Fake RunCommand that records every [bin, args] and can be told which ones to fail. */
function fakeRun(failOnArgs?: string): { calls: Array<[string, string[]]>; run: RunCommand } {
  const calls: Array<[string, string[]]> = []
  const run: RunCommand = async (bin, args) => {
    calls.push([bin, args])
    return !(failOnArgs && args.includes(failOnArgs))
  }
  return { calls, run }
}

interface CapturedSpawn { cmd: string; args: string[] }
function makeSpawn(): { calls: CapturedSpawn[]; fn: Parameters<typeof launchCli>[3] } {
  const calls: CapturedSpawn[] = []
  const fn: Parameters<typeof launchCli>[3] = (cmd, args) => {
    calls.push({ cmd, args })
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    setImmediate(() => ee.emit('exit', 0, null))
    return ee
  }
  return { calls, fn }
}

function silenceOutput(): () => void {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith('▸')) return true
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  return () => { process.stdout.write = outW; process.stderr.write = errW }
}

function makeFetch(): typeof fetch {
  const fn = async (input: string | URL | globalThis.Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/v1/status')) {
      return { ok: true, status: 200, json: async () => ({ engine: { state: 'running' }, model: { key: 'm', name: 'm' } }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return fn as unknown as typeof fetch
}

const DISABLED_VAR = 'TOBOLLM_PI_DISABLE_SEARCH_INSTALL'
beforeEach(() => { delete process.env[DISABLED_VAR] })
afterEach(() => { delete process.env[DISABLED_VAR] })

// ── piSearchPackagePresent ─────────────────────────────────────────────────────

test('piSearchPackagePresent: true when the package is already in settings.json packages', async () => {
  const fs = memFs({ [SETTINGS]: settingsWithPackages('npm:@foo/bar@1.0.0', ENTRY) })
  assert.equal(await piSearchPackagePresent(fs), true)
})

test('piSearchPackagePresent: false when the package is not listed', async () => {
  const fs = memFs({ [SETTINGS]: settingsWithPackages('npm:@foo/bar@1.0.0') })
  assert.equal(await piSearchPackagePresent(fs), false)
})

test('piSearchPackagePresent: false when settings.json is missing or unparseable', async () => {
  assert.equal(await piSearchPackagePresent(memFs()), false, 'missing settings.json → not present → install runs')
  assert.equal(await piSearchPackagePresent(memFs({ [SETTINGS]: 'not json {' })), false, 'garbage settings.json → not present → install runs')
})

// ── ensurePiSearchPackage ──────────────────────────────────────────────────────

test('ensurePiSearchPackage: runs `pi install npm:<pinned spec>` when not already present', async () => {
  const { calls, run } = fakeRun()
  const fs = memFs() // no settings.json → not present → install
  await ensurePiSearchPackage(run, fs)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['pi', ['install', `npm:${SPEC}`]])
})

test('ensurePiSearchPackage: SKIPS the install when the package is already present (no network cost)', async () => {
  const { calls, run } = fakeRun()
  const fs = memFs({ [SETTINGS]: settingsWithPackages(ENTRY) })
  await ensurePiSearchPackage(run, fs)
  assert.equal(calls.length, 0, 'an already-present package must never trigger a second install')
})

test('ensurePiSearchPackage: respects a manual install of a DIFFERENT version (never a silent downgrade)', async () => {
  // A user who hand-installed 0.4.0 must keep it — we match on the package NAME, not the exact
  // pinned version, so we never reinstall our pinned 0.3.0 under them.
  const { calls, run } = fakeRun()
  const fs = memFs({ [SETTINGS]: settingsWithPackages('npm:@heyhuynhgiabuu/pi-search@0.4.0') })
  await ensurePiSearchPackage(run, fs)
  assert.equal(calls.length, 0, 'a differently-versioned manual install must be respected')
})

test('ensurePiSearchPackage: a failed install (run returns false) surfaces a stderr note but still does not fail the launch', async () => {
  const { run } = fakeRun('npm:@heyhuynhgiabuu/pi-search@0.3.0') // fails
  const fs = memFs()
  const captured: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    // await the full completion — a rejected return would throw here, so this also asserts the
    // launch is not failed by the failed install. The note is written only after the awaits resolve.
    await ensurePiSearchPackage(run, fs)
    assert.match(captured.join(''), /could not auto-install pi research tools/, 'a failed install must be visible to the user')
  } finally {
    process.stderr.write = realWrite
  }
})

test('ensurePiSearchPackage: a thrown error is swallowed, never propagated', async () => {
  const run: RunCommand = async () => { throw new Error('network down') }
  const fs = memFs()
  const captured: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    // awaiting (not doesNotThrow) also exercises the full swallow path — a rejection would surface here.
    await ensurePiSearchPackage(run, fs)
    assert.match(captured.join(''), /could not auto-install pi research tools/, 'a thrown install must also surface the note')
  } finally {
    process.stderr.write = realWrite
  }
})

test('ensurePiSearchPackage: a non-zero exit is also fine — still no throw', async () => {
  const run: RunCommand = async () => false // install returned exit 1
  const fs = memFs()
  await assert.doesNotThrow(() => ensurePiSearchPackage(run, fs))
})

test('runWithTimeout: resolves false when the child never exits (bounds an offline install)', async () => {
  // A child that never emits exit/error must still resolve false after the timeout — that is the whole
  // point for an OFFLINE `pi install` that npm will not return on. Feed a stub spawn that returns an
  // EventEmitter we never emit on.
  const neverExiting = ((_cmd: string, _args: string[], _opts: unknown) => {
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    return ee
  }) as Parameters<typeof runWithTimeout>[0]
  const start = Date.now()
  const result = await runWithTimeout(neverExiting, 'pi', ['install'], 20)
  const elapsed = Date.now() - start
  assert.equal(result, false)
  assert.ok(elapsed >= 15 && elapsed < 2000, `resolved near the 20 ms timeout, took ${elapsed} ms`)
})

test('runWithTimeout: resolves true on a clean exit, false on a non-zero exit', async () => {
  const make = (): {
    stub: Parameters<typeof runWithTimeout>[0]
    ee: ReturnType<typeof import('node:child_process').spawn>
  } => {
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    return { ee, stub: (_cmd: string, _args: string[], _opts: unknown) => ee }
  }
  const { stub: okStub, ee: okEe } = make()
  const okP = runWithTimeout(okStub, 'pi', ['install'], 5000)
  okEe.emit('exit', 0)
  assert.equal(await okP, true)

  const { stub: badStub, ee: badEe } = make()
  const badP = runWithTimeout(badStub, 'pi', ['install'], 5000)
  badEe.emit('exit', 1)
  assert.equal(await badP, false)
})

test('ensurePiSearchPackage: a SUCCESSFUL install is disclosed once but stays silent on the skip', async () => {
  // The success note must fire when WE install (once per machine) but NOT on the common already-present
  // skip — otherwise every launch would re-announce it. Two asserts, two paths.
  const installFs = memFs() // not present → install runs → success note
  const installCaptured: string[] = []
  const installReal = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => { installCaptured.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    await ensurePiSearchPackage(async () => true, installFs) // run succeeds
    assert.match(installCaptured.join(''), /installed pi research tools/, 'a successful install must be disclosed')
  } finally {
    process.stderr.write = installReal
  }

  const skipFs = memFs({ [SETTINGS]: settingsWithPackages(ENTRY) }) // already present → skip
  const skipCaptured: string[] = []
  const skipReal = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => { skipCaptured.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    await ensurePiSearchPackage(async () => true, skipFs)
    assert.equal(skipCaptured.join(''), '', 'an already-present package must not re-announce the install')
  } finally {
    process.stderr.write = skipReal
  }
})

test('ensurePiSearchPackage: disabled via env var makes no install call at all', async () => {
  const { calls, run } = fakeRun()
  const fs = memFs()
  process.env[DISABLED_VAR] = '1'
  await ensurePiSearchPackage(run, fs)
  assert.equal(calls.length, 0, 'a disabled machine must never run the install')
})

for (const v of ['1', 'true', 'YES']) {
  test(`ensurePiSearchPackage: truthy "${v}" opts out`, async () => {
    const { calls, run } = fakeRun()
    const fs = memFs()
    process.env[DISABLED_VAR] = v
    await ensurePiSearchPackage(run, fs)
    assert.equal(calls.length, 0)
  })
}

// ── launchCli's use of it ──────────────────────────────────────────────────────

test('launchCli: a pi launch triggers the pi-search install when not already present', async () => {
  const { calls, fn } = makeSpawn()
  const fs = memFs() // empty → not present → install runs
  const unsilence = silenceOutput()
  try {
    const code = await launchCli('pi', 6996, [], fn, undefined, makeFetch(), undefined, fs)
    assert.equal(code, 0)
    const installCall = calls.find((c) => c.cmd === 'pi' && c.args[0] === 'install')
    const allCalls = JSON.stringify(calls.map((c) => [c.cmd, c.args]))
    assert.ok(installCall, `expected a 'pi install' call; got ${allCalls}`)
    assert.deepEqual(installCall!.args, ['install', `npm:${SPEC}`])
  } finally {
    unsilence()
  }
})

test('launchCli: a pi launch does NOT reinstall when the package is already present', async () => {
  const { calls, fn } = makeSpawn()
  const fs = memFs({ [SETTINGS]: settingsWithPackages(ENTRY) }) // already present
  const unsilence = silenceOutput()
  try {
    const code = await launchCli('pi', 6996, [], fn, undefined, makeFetch(), undefined, fs)
    assert.equal(code, 0)
    assert.ok(!calls.some((c) => c.cmd === 'pi' && c.args[0] === 'install'), 'no reinstall for an already-present package')
  } finally {
    unsilence()
  }
})

test('launchCli: a claude launch does NOT trigger the pi-search install', async () => {
  const { calls, fn } = makeSpawn()
  const fs = memFs()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, [], fn, undefined, makeFetch(), undefined, fs)
    assert.ok(!calls.some((c) => c.cmd === 'pi' && c.args[0] === 'install'), 'only pi gets the auto-install')
  } finally {
    unsilence()
  }
})
