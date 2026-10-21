// The explicit `subdir` is now built from HUGGING-FACE-provided directory names (the checkpoint
// picker, ADR-434 (h)) and was joined into the model folder unsanitised. It gets the same
// segment filter the per-repo subfolder has always had, so no `..` can walk out of the library.
// Temp directories only; fetch is frozen, so nothing is downloaded and no port is touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DownloadManager, DownloadError, isHfHost } from './downloads'
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

// ── HF token scope ────────────────────────────────────────────────────────────
// The download fetch carried the HF token to whatever host a raw import URL named, so pasting
// a model link from any other site handed that site the user's Hugging Face token.

/** Record each download fetch's URL + headers; never resolve, so nothing leaves the machine. */
function captureFetch(): { calls: Array<{ url: string; headers: Record<string, string> }>; restore: () => void } {
  const real = globalThis.fetch
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
    return new Promise(() => {})
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

async function headersSentFor(url: string): Promise<Record<string, string>> {
  const cap = captureFetch()
  try {
    const root = tmpDir('tllm-dl-token-')
    const modelDir = join(root, 'models')
    const stateDir = join(root, 'state')
    mkdirSync(modelDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({ 'User-Agent': 'TurboLLM/test', Authorization: 'Bearer hf_secret' }))
    const [rec] = await dm.enqueue({ url })
    for (let i = 0; i < 200 && !cap.calls.some((c) => c.url === rec.url); i++) await new Promise((r) => setTimeout(r, 5))
    const call = cap.calls.find((c) => c.url === rec.url)
    assert.ok(call, `no download fetch was made for ${rec.url}`)
    return call.headers
  } finally {
    cap.restore()
  }
}

test('a raw import from a non-HF host is fetched without the HF token', async () => {
  const headers = await headersSentFor('https://example.invalid/files/model-Q4_K_M.gguf')
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers['User-Agent'], 'TurboLLM/test')
})

test('a Hugging Face download still sends the HF token, so gated repos keep working', async () => {
  const headers = await headersSentFor('https://huggingface.co/owner/repo/resolve/main/model-Q4_K_M.gguf')
  assert.equal(headers.Authorization, 'Bearer hf_secret')
})

test('isHfHost accepts only Hugging Face hosts', () => {
  assert.equal(isHfHost('https://huggingface.co/owner/repo/resolve/main/m.gguf'), true)
  assert.equal(isHfHost('https://hf.co/owner/repo/resolve/main/m.gguf'), true)
  assert.equal(isHfHost('https://HuggingFace.co/x.gguf'), true)
  assert.equal(isHfHost('https://huggingface.co.evil.example/x.gguf'), false)
  assert.equal(isHfHost('https://evilhuggingface.co/x.gguf'), false)
  assert.equal(isHfHost('https://example.invalid/huggingface.co/x.gguf'), false)
  assert.equal(isHfHost('not a url'), false)
})
