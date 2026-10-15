import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { majorMinor, cmpMajorMinor, pickCudaVersion, provisionCuda, swapInStagedDir, type CudaProvisionProgress } from './cuda-provision'
import { tmpDir } from '../test-support/tmp'
import { buildZipArchive } from '../test-support/zip-archive'

test('majorMinor: takes the first two components', () => {
  assert.equal(majorMinor('13.0.1'), '13.0')
  assert.equal(majorMinor('12.6.85'), '12.6')
  assert.equal(majorMinor('13'), '13.0')
})

test('cmpMajorMinor: orders by major then minor', () => {
  assert.ok(cmpMajorMinor('12.8', '13.0') < 0)
  assert.ok(cmpMajorMinor('13.0', '12.8') > 0)
  assert.equal(cmpMajorMinor('12.6', '12.6'), 0)
  assert.ok(cmpMajorMinor('12.6', '12.8') < 0)
})

const KNOWN = ['13.0.1', '13.0.0', '12.8.1', '12.6.3', '12.4.1']

test('pickCudaVersion: newest version the driver supports', () => {
  // Driver maxes at 13.0 → newest 13.0.x is fine.
  assert.equal(pickCudaVersion('13.0', KNOWN), '13.0.1')
  // Driver maxes at 12.8 → skip the 13.0 entries, take 12.8.1.
  assert.equal(pickCudaVersion('12.8', KNOWN), '12.8.1')
  // Driver maxes at 12.6 → 12.6.3.
  assert.equal(pickCudaVersion('12.6', KNOWN), '12.6.3')
})

test('pickCudaVersion: handles a driver newer than anything we know (takes newest known)', () => {
  assert.equal(pickCudaVersion('99.9', KNOWN), '13.0.1')
})

test('pickCudaVersion: driver older than all known → oldest known (best effort)', () => {
  assert.equal(pickCudaVersion('11.0', KNOWN), '12.4.1')
})

test('pickCudaVersion: unknown driver → newest known', () => {
  assert.equal(pickCudaVersion(null, KNOWN), '13.0.1')
})

test('pickCudaVersion: accepts a full driver-max like "13.0.88"', () => {
  assert.equal(pickCudaVersion('13.0.88', KNOWN), '13.0.1')
})

// The toolkit swap must be a rename, never a copy: an interrupted ~1 GB copy wrote bin/nvcc.exe
// before include/ and lib/, and provisionCuda's reuse check (bin/nvcc.exe exists) then took the
// half-copied toolkit as complete forever.
test('swapInStagedDir: renames the staged toolkit into place, replacing an incomplete one', async (t) => {
  const dir = tmpDir('tllm-cuda-swap-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stage = join(dir, '13.0.partial')
  const dest = join(dir, '13.0')
  mkdirSync(join(stage, 'bin'), { recursive: true })
  mkdirSync(join(stage, 'include'))
  writeFileSync(join(stage, 'bin', 'nvcc.exe'), 'new')
  writeFileSync(join(stage, 'include', 'cuda.h'), 'header')
  mkdirSync(join(dest, 'bin'), { recursive: true })
  writeFileSync(join(dest, 'bin', 'stale.dll'), 'old')
  const stagedHeader = statSync(join(stage, 'include', 'cuda.h')).ino

  await swapInStagedDir(stage, dest)

  assert.equal(statSync(join(dest, 'include', 'cuda.h')).ino, stagedHeader, 'moved, not copied')
  assert.equal(readFileSync(join(dest, 'bin', 'nvcc.exe'), 'utf8'), 'new')
  assert.equal(existsSync(join(dest, 'bin', 'stale.dll')), false)
  assert.deepEqual(readdirSync(dir), ['13.0'])
})

// Once the new toolkit is in place the install has succeeded: a Windows lock on the replaced one (AV, indexer) must
// not turn that into a reported failure. The leftover is removed by the next swap.
test('swapInStagedDir: a failed delete of the replaced toolkit does not fail the swap', async (t) => {
  const dir = tmpDir('tllm-cuda-swap-locked-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stage = join(dir, '13.0.partial')
  const dest = join(dir, '13.0')
  mkdirSync(join(stage, 'bin'), { recursive: true })
  writeFileSync(join(stage, 'bin', 'nvcc.exe'), 'new')
  mkdirSync(join(dest, 'bin'), { recursive: true })
  const realRmSync = fs.rmSync
  // `swapInStagedDir` imports rmSync by name: syncBuiltinESMExports carries the patched function to that binding.
  const locked = t.mock.method(fs, 'rmSync', (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p) === `${dest}.old` && existsSync(p)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return realRmSync(p, o)
  })
  syncBuiltinESMExports()
  try {
    await swapInStagedDir(stage, dest)
  } finally {
    locked.mock.restore()
    syncBuiltinESMExports()
  }

  assert.equal(readFileSync(join(dest, 'bin', 'nvcc.exe'), 'utf8'), 'new')
  assert.ok(locked.mock.calls.some((c) => String(c.arguments[0]) === `${dest}.old`), 'the replaced toolkit was deleted through the patched rmSync')

  // The next swap removes the leftover first.
  mkdirSync(join(stage, 'bin'), { recursive: true })
  writeFileSync(join(stage, 'bin', 'nvcc.exe'), 'newer')
  await swapInStagedDir(stage, dest)
  assert.equal(readFileSync(join(dest, 'bin', 'nvcc.exe'), 'utf8'), 'newer')
  assert.deepEqual(readdirSync(dir), ['13.0'])
})

// The stage is thousands of files copied in moments before the swap, and Windows refuses to rename a directory while
// AV or the indexer holds any file under it open (EPERM). That lock is brief: the swap retries rather than failing the
// build and throwing away its 1–3 GB download.
test('swapInStagedDir: a staged toolkit that Windows briefly refuses to rename is still swapped in', async (t) => {
  const dir = tmpDir('tllm-cuda-swap-eperm-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stage = join(dir, '13.0.partial')
  const dest = join(dir, '13.0')
  mkdirSync(join(stage, 'bin'), { recursive: true })
  writeFileSync(join(stage, 'bin', 'nvcc.exe'), 'new')
  mkdirSync(join(dest, 'bin'), { recursive: true })
  writeFileSync(join(dest, 'bin', 'stale.dll'), 'old')
  const realRenameSync = fs.renameSync
  let refusals = 2
  // The renames go through download.ts's renameWithRetry, which imports renameSync by name: syncBuiltinESMExports
  // carries the patched function to that binding.
  const locked = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === stage && refusals-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    return realRenameSync(from, to)
  })
  const actualPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' }) // the retry is Windows-only, like the lock it waits out
  syncBuiltinESMExports()
  try {
    await swapInStagedDir(stage, dest)
  } finally {
    Object.defineProperty(process, 'platform', { value: actualPlatform })
    locked.mock.restore()
    syncBuiltinESMExports()
  }

  assert.equal(readFileSync(join(dest, 'bin', 'nvcc.exe'), 'utf8'), 'new')
  assert.equal(existsSync(join(dest, 'bin', 'stale.dll')), false)
  assert.deepEqual(readdirSync(dir), ['13.0'])
  assert.equal(locked.mock.calls.filter((c) => String(c.arguments[0]) === stage).length, 3)
})

// Older versions copied the assembled toolkit into place, and a copy interrupted or failed partway (a quit, a crash, an
// AV lock, a full disk) left bin/nvcc.exe without the rest of include/ and lib/. That dir must not be reused as a
// complete toolkit: it is downloaded again and swapped in, and only a toolkit this flow finished is reused after that.
test('provisionCuda: a toolkit an older copy left half done is downloaded again; a finished one is reused', async (t) => {
  const dataDir = tmpDir('tllm-cuda-provision-')
  const version = '12.4.1' // the only manifest served below, whatever the driver here prefers
  const root = join(dataDir, 'cuda', version)
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'nvcc.exe'), 'left by an interrupted copy')

  const files: Record<string, string[]> = {
    cuda_nvcc: ['bin/nvcc.exe'],
    cuda_cudart: ['include/cuda_runtime.h', 'lib/x64/cudart.lib'],
    libcublas: ['include/cublas_v2.h', 'lib/x64/cublas.lib'],
    cuda_cccl: ['include/cub/cub.cuh'],
  }
  const manifest = Object.fromEntries(
    Object.keys(files).map((id) => [id, { 'windows-x86_64': { relative_path: `${id}/${id}.zip` } }]),
  )
  const actualPlatform = process.platform
  const componentFetches: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('.json')) return url.endsWith(`redistrib_${version}.json`) ? Response.json(manifest) : new Response('', { status: 404 })
    // provisionCuda refuses anything but Windows; the extraction then runs with this machine's own extractor.
    Object.defineProperty(process, 'platform', { value: actualPlatform })
    const id = url.slice(url.lastIndexOf('/') + 1, -'.zip'.length)
    componentFetches.push(id)
    return new Response(buildZipArchive(files[id].map((f) => ({ name: `${id}-windows-x86_64-1.0-archive/${f}` }))))
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
    Object.defineProperty(process, 'platform', { value: actualPlatform })
  })
  const provision = async () => {
    const progress: string[] = []
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const tk = await provisionCuda(dataDir, (p: CudaProvisionProgress) => progress.push(p.message), new AbortController().signal)
    Object.defineProperty(process, 'platform', { value: actualPlatform })
    return { tk, progress }
  }

  const first = await provision()
  assert.equal(first.tk.root, root)
  assert.ok(!first.progress.some((m) => m.includes('reusing')), first.progress.join('\n'))
  assert.deepEqual(componentFetches, Object.keys(files))
  assert.equal(readFileSync(join(root, 'bin', 'nvcc.exe'), 'utf8'), 'content of cuda_nvcc-windows-x86_64-1.0-archive/bin/nvcc.exe')
  assert.ok(existsSync(join(root, 'include', 'cuda_runtime.h')))
  assert.ok(existsSync(join(root, 'lib', 'x64', 'cublas.lib')))
  assert.deepEqual(readdirSync(join(dataDir, 'cuda')), [version])

  componentFetches.length = 0
  const second = await provision()
  assert.equal(second.tk.binDir, join(root, 'bin'))
  assert.ok(second.progress.some((m) => m.includes(`CUDA ${version} already downloaded`)), second.progress.join('\n'))
  assert.deepEqual(componentFetches, [])
})
