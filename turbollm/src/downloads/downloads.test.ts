// The explicit `subdir` is now built from HUGGING-FACE-provided directory names (the checkpoint
// picker, ADR-434 (h)) and was joined into the model folder unsanitised. It gets the same
// segment filter the per-repo subfolder has always had, so no `..` can walk out of the library,
// and a folder link inside the library cannot carry a download out of it either.
// Temp directories only; fetch is frozen, so nothing is downloaded and no port is touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DownloadManager, DownloadError } from './downloads'
import { toDownloadFailure } from '../api/download-lifecycle'
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

test('a subdir of nothing but dots is no subdir at all, so the single-file model rule applies again', async () => {
  const restore = stubFetch()
  try {
    const { dm } = newManager()
    await assert.rejects(
      () => dm.enqueue({ repo: 'AlexWortega/openjev', rfilename: 'qwen3.5-4b-nli-v2/config.json', subdir: '..' }),
      (e: unknown) => e instanceof DownloadError && e.code === 'invalid_url' && e.message === 'The file must be a .gguf or .litertlm model file.',
    )
  } finally {
    restore()
  }
})

test('a .litertlm HF repo file enqueues as one self-contained model under <owner>/<repo>', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, dm } = newManager()
    const [rec] = await dm.enqueue({
      repo: 'litert-community/gemma-4-E2B-it-litert-lm',
      rfilename: 'gemma-4-E2B-it-gpu.litertlm',
      size: 2_008_432_640,
    })

    assert.equal(rec.name, 'gemma-4-E2B-it-gpu.litertlm')
    assert.equal(rec.dest, join(modelDir, 'litert-community', 'gemma-4-E2B-it-litert-lm', 'gemma-4-E2B-it-gpu.litertlm'))
    assert.equal(rec.url, 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-gpu.litertlm')
    assert.equal(rec.total, 2_008_432_640)
  } finally {
    restore()
  }
})

test('a non-HF URL import of a .litertlm bundle downloads as a single flat file', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, dm } = newManager()
    const [rec] = await dm.enqueue({ url: 'https://example.invalid/files/model_q4.litertlm' })

    assert.equal(rec.name, 'model_q4.litertlm')
    assert.equal(rec.dest, join(modelDir, 'model_q4.litertlm'))
  } finally {
    restore()
  }
})

test('an HF resolve URL to a .litertlm bundle takes the repo download path, not a raw import', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, dm } = newManager()
    // No expander wired: the repo path still resolves the destination from the repo id.
    const [rec] = await dm.enqueue({
      url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-gpu.litertlm',
    })

    assert.equal(rec.repo, 'litert-community/gemma-4-E2B-it-litert-lm')
    assert.equal(rec.dest, join(modelDir, 'litert-community', 'gemma-4-E2B-it-litert-lm', 'gemma-4-E2B-it-gpu.litertlm'))
  } finally {
    restore()
  }
})

test('a non-model file extension is still rejected for both a raw URL and a repo file', async () => {
  const restore = stubFetch()
  try {
    const { dm } = newManager()
    await assert.rejects(
      () => dm.enqueue({ url: 'https://example.invalid/files/model.safetensors' }),
      (e: unknown) => e instanceof DownloadError && e.code === 'invalid_url' && e.message === 'URL must point to a .gguf or .litertlm model file.',
    )
    await assert.rejects(
      () => dm.enqueue({ repo: 'someone/model', rfilename: 'model.safetensors' }),
      (e: unknown) => e instanceof DownloadError && e.code === 'invalid_url' && e.message === 'The file must be a .gguf or .litertlm model file.',
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

test('a folder link inside the model folder cannot carry a download out of it; a link that stays inside still works', async () => {
  const restore = stubFetch()
  try {
    const root = tmpDir('tllm-dl-link-')
    const modelDir = join(root, 'models')
    const stateDir = join(root, 'state')
    const outside = join(root, 'outside')
    for (const d of [modelDir, stateDir, outside, join(modelDir, 'real')]) mkdirSync(d, { recursive: true })
    // 'junction': a folder link Windows makes without admin rights; elsewhere the type is ignored.
    symlinkSync(outside, join(modelDir, 'ext'), 'junction')
    symlinkSync(outside, join(modelDir, 'evil'), 'junction')
    symlinkSync(join(modelDir, 'real'), join(modelDir, 'alias'), 'junction')
    const echo = async (_repo: string, rfilename: string) => ({ dir: '', files: [{ rfilename, size: 10, mmproj: false }] })
    const plain = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const expanding = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echo)

    const refused = (e: unknown) =>
      e instanceof DownloadError && e.code === 'invalid_request' && e.message === 'The download folder leads out of the model folder through a link.'
    // An HF repo file with a subdir (the whole-folder dialog's shape), a raw URL with a subdir,
    // and a repo whose own subfolder (<owner> = evil) is the link, with and without the expander.
    await assert.rejects(() => plain.enqueue({ repo: 'evil/repo', rfilename: 'payload.sh', subdir: 'ext/deeper' }), refused)
    await assert.rejects(() => plain.enqueue({ url: 'https://example.invalid/x/authorized_keys', subdir: 'ext' }), refused)
    await assert.rejects(() => plain.enqueue({ repo: 'evil/repo', rfilename: 'model.gguf' }), refused)
    await assert.rejects(() => expanding.enqueue({ repo: 'evil/repo', rfilename: 'model.gguf' }), refused)
    assert.deepEqual(readdirSync(outside), [], 'no folder or file is made out there')
    assert.equal(plain.list().length + expanding.list().length, 0)

    // A link to another folder inside the model folder is still inside.
    const [inside] = await plain.enqueue({ repo: 'owner/repo', rfilename: 'config.json', subdir: 'alias/sub' })
    assert.equal(inside.dest, join(modelDir, 'alias', 'sub', 'config.json'))
    assert.ok(existsSync(join(modelDir, 'real', 'sub')))

    // A model folder that is itself a link (models reached through ~/models -> /mnt/disk) works.
    const linked = join(root, 'linked-models')
    symlinkSync(modelDir, linked, 'junction')
    const viaLink = new DownloadManager(fakeStore(linked, stateDir), () => {}, () => ({}), echo)
    const [rec] = await viaLink.enqueue({ repo: 'owner/other', rfilename: 'model.gguf' })
    assert.equal(rec.dest, join(linked, 'owner', 'other', 'model.gguf'))
  } finally {
    restore()
  }
})

// A folder that cannot be resolved at all is not a link out of the model folder: it is still
// refused, but with the fs error, as enqueue reports any other fs failure (500 internal, the
// message kept off the Turbo Link facade), not as an escape the owner then looks for in vain.
// ENAMETOOLONG stands in for an lstat refused with EACCES (which a test run as root never gets)
// or a primary folder on a Windows drive that is gone.
test('a download folder that cannot be resolved is refused with its fs error, not as a link out of the model folder', {
  skip: process.platform === 'win32' && 'Windows may report a too-long name as ENOENT, not ENAMETOOLONG',
}, async () => {
  const restore = stubFetch()
  try {
    const root = tmpDir('tllm-dl-unresolved-')
    const modelDir = join(root, 'models')
    const stateDir = join(root, 'state')
    for (const d of [modelDir, stateDir]) mkdirSync(d, { recursive: true })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    let thrown: unknown
    await assert.rejects(() => dm.enqueue({ repo: 'owner/repo', rfilename: 'config.json', subdir: 'x'.repeat(300) }), (e) => {
      thrown = e
      return true
    })
    assert.ok(!(thrown instanceof DownloadError), 'not a caller-actionable refusal')
    assert.match((thrown as Error).message, /^The download folder could not be checked: ENAMETOOLONG: /)
    assert.doesNotMatch((thrown as Error).message, /through a link/)
    const failure = toDownloadFailure(thrown)
    assert.deepEqual([failure.status, failure.code, failure.hostDetail], [500, 'internal', true])
    assert.deepEqual(readdirSync(modelDir), [], 'nothing is made')
    assert.equal(dm.list().length, 0)
  } finally {
    restore()
  }
})
