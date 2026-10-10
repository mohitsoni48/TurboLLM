// LiteRT-LM discovery: the `litert-lm` engine browses HF with the litert-lm facet (not
// gguf), a `.litertlm` repo renders as a variant picker instead of "No GGUF files found",
// and expanding a bundle yields exactly itself (no split siblings, no mmproj companion).
// Every HF call is stubbed; this test never touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HfClient, type RawTreeEntry } from './hf'
import { DownloadError } from '../downloads/downloads'

const client = () => new HfClient(() => '', '0.0.0-test')

function file(path: string, size?: number, oid?: string): RawTreeEntry {
  return { type: 'file', path, ...(oid ? { lfs: { oid, size } } : { size }) }
}

/** Routes by URL: repo info, the recursive tree, the card. Mirrors hf.test.ts's stub. */
function stubHf(tree: RawTreeEntry[], repo = 'litert-community/gemma-4-E2B-it-litert-lm') {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/tree/')) {
      return new Response(JSON.stringify(tree), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/models/')) {
      return new Response(JSON.stringify({ downloads: 1, likes: 2, tags: ['litert-lm'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('# card', { status: 200 })
  }) as typeof fetch
  return { urls, restore: () => { globalThis.fetch = real }, repo }
}

// The real litert-community/gemma-4-E2B-it-litert-lm layout (verified live): one repo
// holding gpu/web/device variants of the same model, plus non-model files.
const LITERT_TREE: RawTreeEntry[] = [
  file('README.md', 13758),
  file('chat_template.jinja', 11995),
  file('notebook.ipynb', 24232),
  file('gemma-4-E2B-it-gpu.litertlm', 2_008_432_640, 'sha-gpu'),
  file('gemma-4-E2B-it-web.litertlm', 2_008_432_640, 'sha-web'),
  file('gemma-4-E2B-it.litertlm', 2_588_147_712, 'sha-base'),
  file('gemma-4-E2B-it_Google_Tensor_G5.litertlm', 3_113_545_589, 'sha-g5'),
]

test('a .litertlm repo is a litertlm repo: one self-contained entry per bundle, no safetensors/checkpoints', async () => {
  const stub = stubHf(LITERT_TREE)
  try {
    const detail = await client().getRepo('litert-community/gemma-4-E2B-it-litert-lm')

    assert.equal(detail.litertlm, true)
    assert.equal(detail.safetensors, undefined)
    assert.equal('checkpoints' in detail, false)
    assert.deepEqual(
      detail.files.map((f) => f.name),
      ['gemma-4-E2B-it-gpu.litertlm', 'gemma-4-E2B-it-web.litertlm', 'gemma-4-E2B-it.litertlm', 'gemma-4-E2B-it_Google_Tensor_G5.litertlm'],
    )
    for (const f of detail.files) {
      assert.equal(f.litertlm, true)
      assert.equal(f.parts, 1)
      assert.equal(f.mmproj, false)
      assert.ok(f.url.endsWith(`/resolve/main/${f.name}`), f.url)
      // Every bundle row carries both labels: the hardware variant, and the precision
      // the name states ('?' when it states none — the same reading the library scanner
      // gives the downloaded file, so Discover and the library agree on one file).
      assert.ok(f.variant && f.variant.length > 0, f.name)
      assert.equal(f.quant, '?')
    }
    assert.equal(detail.files.find((f) => f.name === 'gemma-4-E2B-it.litertlm')?.sha256, 'sha-base')
  } finally {
    stub.restore()
  }
})

test('litertlm variant labels read as the distinguishing suffix, not the shared model name', async () => {
  const stub = stubHf(LITERT_TREE)
  try {
    const detail = await client().getRepo('litert-community/gemma-4-E2B-it-litert-lm')
    const label = (name: string) => detail.files.find((f) => f.name === name)?.variant

    assert.equal(label('gemma-4-E2B-it.litertlm'), 'Default')
    assert.equal(label('gemma-4-E2B-it-gpu.litertlm'), 'GPU')
    assert.equal(label('gemma-4-E2B-it_Google_Tensor_G5.litertlm'), 'Google Tensor G5')
  } finally {
    stub.restore()
  }
})

test('a mid-token common prefix is backed up to a separator, so near-identical device builds label whole tokens', async () => {
  // Real shape of litert-community/Gemma3-1B-IT: mt6989 vs mt6991 share '…_mt69'.
  const tree = [
    file('Gemma3-1B-IT_q4_ekv1280_mt6989.litertlm', 1_000_000_000, 'sha-89'),
    file('Gemma3-1B-IT_q4_ekv1280_mt6991.litertlm', 1_000_000_000, 'sha-91'),
  ]
  const stub = stubHf(tree)
  try {
    const detail = await client().getRepo('litert-community/Gemma3-1B-IT')
    assert.deepEqual(
      detail.files.map((f) => f.variant),
      ['MT6989', 'MT6991'],
    )
    // The precision the name states rides in `quant`, exactly as the library scanner
    // reads the same file after download — one field, one meaning.
    assert.deepEqual(
      detail.files.map((f) => f.quant),
      ['Q4', 'Q4'],
    )
  } finally {
    stub.restore()
  }
})

test('letter+digit compound tokens label uppercase like quant labels — INT4, FP16, MT6989 — while words stay title-case', async () => {
  // Casing must not depend on token LENGTH: an 'int4' beside a 'q4' both read as quant
  // ids ('INT4'/'Q4'), not 'Int4' vs 'Q4'; 'fp16'/'bf16' read 'FP16'/'BF16'. Pure words
  // over three chars still title-case.
  const tree = [
    file('gemma_q4.litertlm', 1_000_000_000, 'sha-q4'),
    file('gemma_int4.litertlm', 1_100_000_000, 'sha-int4'),
    file('gemma_fp16.litertlm', 1_200_000_000, 'sha-fp16'),
    file('gemma_mediatek_mt6989.litertlm', 1_300_000_000, 'sha-mt'),
    file('gemma_Google_Tensor_G5.litertlm', 1_400_000_000, 'sha-g5'),
  ]
  const stub = stubHf(tree)
  try {
    const detail = await client().getRepo('litert-community/gemma-variants')
    const label = (name: string) => detail.files.find((f) => f.name === name)?.variant
    const quant = (name: string) => detail.files.find((f) => f.name === name)?.quant

    assert.equal(label('gemma_q4.litertlm'), 'Q4')
    assert.equal(label('gemma_int4.litertlm'), 'INT4')
    assert.equal(label('gemma_fp16.litertlm'), 'FP16')
    assert.equal(label('gemma_mediatek_mt6989.litertlm'), 'Mediatek MT6989')
    assert.equal(label('gemma_Google_Tensor_G5.litertlm'), 'Google Tensor G5')
    // `quant` is the scanner's precision reading of the same names — the device labels
    // above live in `variant`, so a file never shows 'Q4' in Discover and 'GPU' in the
    // library off the same field.
    assert.equal(quant('gemma_q4.litertlm'), 'Q4')
    assert.equal(quant('gemma_int4.litertlm'), 'INT4')
    assert.equal(quant('gemma_fp16.litertlm'), 'FP16')
    assert.equal(quant('gemma_mediatek_mt6989.litertlm'), '?')
    assert.equal(quant('gemma_Google_Tensor_G5.litertlm'), '?')
  } finally {
    stub.restore()
  }
})

test('same-named bundles in different subfolders get their full repo path as the name, so every one stays selectable', async () => {
  // Two 'model.litertlm' basenames in 'gpu/' and 'web/': with plain basenames the picker
  // would list two indistinguishable rows (same name, same 'Default' label) and BOTH
  // would enqueue the first tree match. The full-path name disambiguates selection,
  // provenance and expansion; the label folds the subfolder in so the rows read apart.
  const tree = [
    file('README.md', 500),
    file('gpu/model.litertlm', 1_000_000_000, 'sha-gpu'),
    file('web/model.litertlm', 800_000_000, 'sha-web'),
  ]
  const stub = stubHf(tree, 'litert-community/two-builds')
  try {
    const detail = await client().getRepo('litert-community/two-builds')

    assert.equal(detail.litertlm, true)
    assert.deepEqual(
      detail.files.map((f) => f.name),
      ['web/model.litertlm', 'gpu/model.litertlm'], // size-ascending
    )
    assert.equal(detail.files.find((f) => f.name === 'gpu/model.litertlm')?.variant, 'GPU Model')
    assert.equal(detail.files.find((f) => f.name === 'web/model.litertlm')?.variant, 'WEB Model')
    assert.ok(detail.files.find((f) => f.name === 'gpu/model.litertlm')?.url.endsWith('/resolve/main/gpu/model.litertlm'))
  } finally {
    stub.restore()
  }
})

test('expanding a full-path name from a basename-colliding repo resolves THAT bundle, not the first basename match', async () => {
  const tree = [file('gpu/model.litertlm', 1_000_000_000, 'sha-gpu'), file('web/model.litertlm', 800_000_000, 'sha-web')]
  const stub = stubHf(tree, 'litert-community/two-builds')
  try {
    const expanded = await client().expandModelFiles('litert-community/two-builds', 'web/model.litertlm')

    assert.equal(expanded.dir, 'web')
    assert.deepEqual(expanded.files, [{ rfilename: 'web/model.litertlm', size: 800_000_000, sha256: 'sha-web', mmproj: false }])
  } finally {
    stub.restore()
  }
})

test('a repo with GGUFs keeps its GGUF classification even when it also ships .litertlm bundles', async () => {
  const tree = [file('model-Q4_K_M.gguf', 4_000_000_000, 'sha-gguf'), file('model_q4.litertlm', 3_000_000_000, 'sha-lt')]
  const stub = stubHf(tree)
  try {
    const detail = await client().getRepo('someone/mixed')
    assert.equal(detail.litertlm, undefined)
    assert.equal(detail.files.length, 1)
    assert.equal(detail.files[0].name, 'model-Q4_K_M.gguf')
  } finally {
    stub.restore()
  }
})

test('a repo with safetensors weights keeps that classification even when it also ships .litertlm bundles', async () => {
  const tree = [file('config.json', 1200), file('model.safetensors', 5_000_000_000, 'sha-st'), file('model_q4.litertlm', 3_000_000_000, 'sha-lt')]
  const stub = stubHf(tree)
  try {
    const detail = await client().getRepo('someone/mixed-st')
    assert.equal(detail.safetensors, true)
    assert.equal(detail.litertlm, undefined)
  } finally {
    stub.restore()
  }
})

test('bundles beside config-LESS safetensors classify as litertlm — those weights are not a loadable directory either', async () => {
  // A litert-community repo can carry a stray .safetensors (original weights, an
  // adapter) next to its bundles. Without a root config.json the safetensors are not a
  // loadable HF directory, so classifying the repo safetensors would hand the LiteRT-LM
  // engine (Discover filtered to library=litert-lm) a directory download it cannot load —
  // the bundles win instead.
  const tree = [file('README.md', 500), file('adapter.safetensors', 900_000_000, 'sha-st'), file('model_q4.litertlm', 3_000_000_000, 'sha-lt')]
  const stub = stubHf(tree)
  try {
    const detail = await client().getRepo('litert-community/bundle-with-adapter')
    assert.equal(detail.litertlm, true)
    assert.equal(detail.safetensors, undefined)
    assert.deepEqual(detail.files.map((f) => f.name), ['model_q4.litertlm'])
  } finally {
    stub.restore()
  }
})

test('expanding an ambiguous basename rejects instead of resolving whichever bundle comes first', async () => {
  // Two 'model.litertlm' in 'gpu/' and 'web/': a caller that only knows the basename (an
  // older peer UI over Turbo Link, a raw API client) cannot be served by a first-match
  // guess — size and sha256 would come from the wrong entry and the wrong variant would
  // install silently with a passing integrity check. A typed rejection tells the caller
  // to send the full repo path.
  const tree = [file('gpu/model.litertlm', 1_000_000_000, 'sha-gpu'), file('web/model.litertlm', 800_000_000, 'sha-web')]
  const stub = stubHf(tree, 'litert-community/two-builds')
  try {
    await assert.rejects(
      () => client().expandModelFiles('litert-community/two-builds', 'model.litertlm'),
      (e: unknown) =>
        e instanceof DownloadError &&
        e.code === 'invalid_request' &&
        /ambiguous/i.test(e.message) &&
        e.message.includes("e.g. 'gpu/model.litertlm'"),
    )
  } finally {
    stub.restore()
  }
})

test('expanding a .litertlm bundle yields exactly itself — full path, size and sha from the tree', async () => {
  const stub = stubHf(LITERT_TREE)
  try {
    const expanded = await client().expandModelFiles('litert-community/gemma-4-E2B-it-litert-lm', 'gemma-4-E2B-it-gpu.litertlm')

    assert.equal(expanded.dir, '')
    assert.deepEqual(expanded.files, [{ rfilename: 'gemma-4-E2B-it-gpu.litertlm', size: 2_008_432_640, sha256: 'sha-gpu', mmproj: false }])
  } finally {
    stub.restore()
  }
})

test('expanding a .litertlm from a subfolder resolves the full repo path from its basename and keeps the folder', async () => {
  const tree = [file('variants/gemma-4-E2B-it-gpu.litertlm', 2_008_432_640, 'sha-gpu')]
  const stub = stubHf(tree)
  try {
    const expanded = await client().expandModelFiles('litert-community/gemma-4-E2B-it-litert-lm', 'gemma-4-E2B-it-gpu.litertlm')

    assert.equal(expanded.dir, 'variants')
    assert.deepEqual(expanded.files, [{ rfilename: 'variants/gemma-4-E2B-it-gpu.litertlm', size: 2_008_432_640, sha256: 'sha-gpu', mmproj: false }])
  } finally {
    stub.restore()
  }
})

test('browseModels under the litert-lm engine asks HF for the litert-lm facet, not gguf', async () => {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url))
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await client().browseModels('trending', 'litert-lm')
    const url = urls[0]
    assert.match(url, /filter=litert-lm&/)
    assert.doesNotMatch(url, /filter=gguf/)
  } finally {
    globalThis.fetch = real
  }
})

test('browseModels under sglang (safetensors) asks for no facet, like vLLM', async () => {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url))
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await client().browseModels('trending', 'sglang')
    assert.doesNotMatch(urls[0], /filter=/)
  } finally {
    globalThis.fetch = real
  }
})
