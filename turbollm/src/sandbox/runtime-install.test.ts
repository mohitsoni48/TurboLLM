import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildZipArchive } from '../test-support/zip-archive'
import { tmpDir } from '../test-support/tmp'
import { DENO_VERSION, DENO_ZIPS, PYODIDE_FILES, PYODIDE_VERSION, type RuntimeFile } from './runtime-manifest'
import { RUNTIME_MARKER, runtimeFilesFor, SandboxRuntime, type RuntimeFiles } from './runtime-install'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const file = (name: string, bytes: Buffer): RuntimeFile => ({ url: `https://files.test/${name}`, path: name, size: bytes.length, sha256: sha(bytes) })

/** A tiny runtime: a zip holding a fake deno binary, and two "Pyodide" files. */
function fixture(platform: NodeJS.Platform = 'linux') {
  const bin = platform === 'win32' ? 'deno.exe' : 'deno'
  const bodies = new Map<string, Buffer>([
    ['deno.zip', buildZipArchive([{ name: bin, data: Buffer.from('#!fake deno') }])],
    ['pyodide.asm.wasm', Buffer.from('wasm bytes')],
    ['numpy.whl', Buffer.from('wheel bytes')],
  ])
  const files: RuntimeFiles = {
    deno: file('deno.zip', bodies.get('deno.zip')!),
    pyodide: [file('pyodide.asm.wasm', bodies.get('pyodide.asm.wasm')!), file('numpy.whl', bodies.get('numpy.whl')!)],
  }
  const requested: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const name = String(input).split('/').pop()!
    requested.push(name)
    const body = bodies.get(name)
    return body ? new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } }) : new Response('nope', { status: 404 })
  }) as typeof fetch
  return { bodies, files, fetchImpl, requested }
}

function runtime(over: Partial<ConstructorParameters<typeof SandboxRuntime>[0]> = {}, platform: NodeJS.Platform = 'linux') {
  const fx = fixture(platform)
  const root = tmpDir('sandbox-runtime-')
  const announced: string[] = []
  const rt = new SandboxRuntime({ runtimesDir: () => root, files: fx.files, fetchImpl: fx.fetchImpl, announce: (k) => announced.push(k), freeBytes: () => 1e12, platform, ...over })
  return { rt, root, fx, announced }
}

test('manifest: a pinned build for every desktop target and none on Android', () => {
  for (const key of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) assert.ok(DENO_ZIPS[key], key)
  assert.equal(runtimeFilesFor('android', 'arm64'), null)
  assert.equal(runtimeFilesFor('linux', 'ia32'), null)
  assert.equal(runtimeFilesFor('darwin', 'arm64')?.deno, DENO_ZIPS['darwin-arm64'])
})

test('manifest: every file has an https URL ending in its own name, a size and a 64-hex sha256', () => {
  const all = [...Object.values(DENO_ZIPS), ...PYODIDE_FILES]
  assert.equal(PYODIDE_FILES.length, 20)
  for (const f of all) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path)
    assert.ok(f.size > 0, f.path)
    assert.ok(f.url.startsWith('https://') && f.url.endsWith(`/${f.path}`), f.url)
  }
  assert.equal(new Set(all.map((f) => f.sha256)).size, all.length)
})

test('install: downloads, verifies, unpacks Deno and writes the marker last', async () => {
  const { rt, root, announced } = runtime()
  assert.equal(rt.view().installed, null)
  await rt.install()
  const v = rt.view()
  assert.deepEqual(v.installed, { deno: DENO_VERSION, pyodide: PYODIDE_VERSION })
  assert.equal(v.job.state, 'idle')
  assert.equal(readFileSync(rt.denoPath(), 'utf8'), '#!fake deno')
  assert.ok(existsSync(join(rt.pyodideDir(), 'numpy.whl')))
  assert.ok(existsSync(join(rt.dir(), RUNTIME_MARKER)))
  assert.ok(!existsSync(join(rt.dir(), 'deno.zip')))
  await new Promise((r) => setTimeout(r, 200)) // the stage is removed in the background
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('.sandbox-')), [])
  assert.ok(announced.includes('sandboxRuntime'))
})

test('install: on Windows the binary is deno.exe', async () => {
  const { rt } = runtime({}, 'win32')
  await rt.install()
  assert.ok(rt.denoPath().endsWith('deno.exe'))
  assert.ok(existsSync(rt.denoPath()))
})

test('install: a second call while installed downloads nothing', async () => {
  const { rt, fx } = runtime()
  await rt.install()
  const n = fx.requested.length
  await rt.install()
  assert.equal(fx.requested.length, n)
})

test('install: a file that does not match its pinned hash installs nothing', async () => {
  const fx = fixture()
  fx.bodies.set('numpy.whl', Buffer.from('wheel byteZ')) // same length, different bytes
  const { rt } = runtime({ fetchImpl: fx.fetchImpl })
  await rt.install()
  const v = rt.view()
  assert.equal(v.installed, null)
  assert.equal(v.job.state, 'error')
  assert.equal(v.job.error?.code, 'checksum_failed')
  assert.ok(!existsSync(rt.dir()))
})

test('install: a server announcing another size is refused before the body is read', async () => {
  const fx = fixture()
  const lying = (async (input: string | URL | Request) => {
    const res = await fx.fetchImpl(input)
    return new Response(res.body, { headers: { 'content-length': '999999999' } })
  }) as typeof fetch
  const { rt } = runtime({ fetchImpl: lying })
  await rt.install()
  assert.equal(rt.view().job.error?.code, 'size_mismatch')
})

test('install: a body running past its pinned size is cut off', async () => {
  const fx = fixture()
  const long = (async (input: string | URL | Request) => {
    const res = await fx.fetchImpl(input)
    const body = Buffer.concat([Buffer.from(await res.arrayBuffer()), Buffer.alloc(4096)])
    return new Response(new Uint8Array(body)) // no content-length: only the stream cap can catch it
  }) as typeof fetch
  const { rt } = runtime({ fetchImpl: long })
  await rt.install()
  assert.equal(rt.view().installed, null)
  assert.equal(rt.view().job.error?.code, 'size_mismatch')
})

test('install: refused with a plain message when the disk is too full', async () => {
  const { rt, fx } = runtime({ freeBytes: () => 10 })
  await rt.install()
  assert.equal(rt.view().job.error?.code, 'insufficient_disk')
  assert.equal(fx.requested.length, 0)
})

test('install: an HTTP error fails the job and installs nothing', async () => {
  const fx = fixture()
  fx.bodies.delete('pyodide.asm.wasm')
  const { rt } = runtime({ fetchImpl: fx.fetchImpl })
  await rt.install()
  assert.equal(rt.view().job.error?.code, 'download_failed')
  assert.equal(rt.view().installed, null)
})

test('cancel: stops a running install and leaves nothing installed', async () => {
  const fx = fixture()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    await gate
    init?.signal?.throwIfAborted()
    return fx.fetchImpl(input)
  }) as typeof fetch
  const { rt } = runtime({ fetchImpl: slow })
  const done = rt.install()
  assert.equal(rt.view().job.state, 'running')
  assert.equal(rt.cancel(), true)
  release()
  await done
  assert.equal(rt.view().job.error?.code, 'cancelled')
  assert.equal(rt.view().installed, null)
  assert.equal(rt.cancel(), false)
})

test('remove: deletes the runtime, and is refused while an install runs', async () => {
  const { rt } = runtime()
  await rt.install()
  assert.equal(await rt.remove(), true)
  assert.equal(rt.view().installed, null)
  assert.ok(!existsSync(rt.dir()))
  assert.equal(await rt.remove(), false)

  const fx = fixture()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const busy = runtime({ fetchImpl: (async (i: string | URL | Request) => { await gate; return fx.fetchImpl(i) }) as typeof fetch })
  const done = busy.rt.install()
  await assert.rejects(busy.rt.remove(), { code: 'sandbox_runtime_busy' })
  release()
  await done
})

test('install: refused on a platform with no runtime', () => {
  const rt = new SandboxRuntime({ runtimesDir: () => tmpDir('sandbox-none-'), files: null, platform: 'android' })
  assert.equal(rt.view().supported, false)
  assert.throws(() => rt.install(), { code: 'sandbox_unsupported' })
})

test('install: sweeps stage folders a crash left behind', async () => {
  const { rt, root } = runtime()
  mkdirSync(join(root, '.sandbox-dead1234.stage', 'sandbox'), { recursive: true })
  await rt.install()
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(readdirSync(root).filter((n) => n.endsWith('.stage')), [])
})

test('view: download and disk sizes come from the pinned files', () => {
  const v = new SandboxRuntime({ runtimesDir: () => tmpDir('sandbox-sizes-'), platform: 'linux', files: runtimeFilesFor('linux', 'x64') }).view()
  assert.ok(v.downloadBytes > 70e6 && v.downloadBytes < 80e6, String(v.downloadBytes))
  assert.ok(v.diskBytes > 110e6 && v.diskBytes < 140e6, String(v.diskBytes))
})
