// The explicit `subdir` is now built from HUGGING-FACE-provided directory names (the checkpoint
// picker, ADR-434 (h)) and was joined into the model folder unsanitised. It gets the same
// segment filter the per-repo subfolder has always had, so no `..` can walk out of the library.
// Temp directories only; fetch is frozen, so nothing is downloaded and no port is touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DownloadManager, DownloadError } from './downloads'
import { tmpDir } from '../test-support/tmp'

function fakeStore(modelDir: string, stateDir: string) {
  return {
    dir: () => stateDir,
    snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
  } as unknown as ConstructorParameters<typeof DownloadManager>[0]
}

/** Freeze the background run(): fetch never resolves, so nothing leaves the machine. */
function stubFetch(): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  return () => { globalThis.fetch = real }
}

function newManager() {
  const root = tmpDir('tllm-dl-subdir-')
  const modelDir = join(root, 'models')
  const stateDir = join(root, 'state')
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return { modelDir, dm: new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({})) }
}

async function destOf(subdir: string, rfilename: string): Promise<{ dest: string; modelDir: string }> {
  const restore = stubFetch()
  try {
    const { modelDir, dm } = newManager()
    const [rec] = await dm.enqueue({ repo: 'AlexWortega/openjev', rfilename, subdir })
    return { dest: rec.dest, modelDir }
  } finally {
    restore()
  }
}

test('a checkpoint subdir places the file exactly where the picker asked', async () => {
  const { dest, modelDir } = await destOf('openjev/qwen3.5-4b-nli-v2', 'qwen3.5-4b-nli-v2/config.json')

  assert.equal(dest, join(modelDir, 'openjev', 'qwen3.5-4b-nli-v2', 'config.json'))
})

test('a subdir that tries to climb out lands inside the model folder anyway', async () => {
  const posix = await destOf('../../evil', 'qwen3.5-4b-nli-v2/config.json')
  assert.equal(posix.dest, join(posix.modelDir, 'evil', 'config.json'))

  const windows = await destOf('..\\..\\evil', 'qwen3.5-4b-nli-v2/config.json')
  assert.equal(windows.dest, join(windows.modelDir, 'evil', 'config.json'))
})

test('a subdir of nothing but dots is no subdir at all, so the .gguf rule applies again', async () => {
  const restore = stubFetch()
  try {
    const { dm } = newManager()
    await assert.rejects(
      () => dm.enqueue({ repo: 'AlexWortega/openjev', rfilename: 'qwen3.5-4b-nli-v2/config.json', subdir: '..' }),
      (e: unknown) => e instanceof DownloadError && e.code === 'invalid_url' && e.message === 'The file must be a .gguf.',
    )
  } finally {
    restore()
  }
})

test('a non-HF URL import with a climbing subdir also stays inside the model folder', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, dm } = newManager()
    const [rec] = await dm.enqueue({ url: 'https://example.invalid/files/config.json', subdir: '../escape' })

    assert.equal(rec.dest, join(modelDir, 'escape', 'config.json'))
  } finally {
    restore()
  }
})
