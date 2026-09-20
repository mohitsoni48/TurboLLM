// `getRepo` on a safetensors repo now also reports its checkpoint folders, each with the Jev
// badge read from that folder's OWN config.json (ADR-434 (h)). The root `files` list is
// unchanged — flattening it is exactly what would overwrite one checkpoint with another.
// Every HF call is stubbed; this test never touches the network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HfClient, type HfRepoDetail, type RawTreeEntry } from './hf'
import type { HfCheckpoint } from './checkpoints'

const OPENJEV_CONFIG = {
  architectures: ['Qwen3_5ForSequenceClassification'],
  model_type: 'qwen3_5',
  id2label: { '0': 'contradiction', '1': 'entailment', '2': 'neutral' },
  label2id: { contradiction: 0, entailment: 1, neutral: 2 },
  nli_template: 'Premise: {premise}\nHypothesis: {hypothesis}',
  vision_config: {},
  max_position_embeddings: 262144,
}
const MOE_CONFIG = { ...OPENJEV_CONFIG, architectures: ['Qwen3_5MoeForSequenceClassification'] }

function file(path: string, size?: number, oid?: string): RawTreeEntry {
  return { type: 'file', path, ...(oid ? { lfs: { oid, size } } : { size }) }
}

function checkpointFolder(dir: string, oid: string): RawTreeEntry[] {
  return [
    file(`${dir}/config.json`, 1200),
    file(`${dir}/model.safetensors`, 9_000_000_000, oid),
    file(`${dir}/tokenizer.json`, 7000),
  ]
}

interface Stub {
  configFetches: string[]
  restore: () => void
}

/** Routes by URL: repo info, the recursive tree, each checkpoint's config.json, and the card.
 *  A config path absent from `configs` answers 404, the way an unreadable checkpoint does. */
function stubHf(tree: RawTreeEntry[], configs: Record<string, unknown>): Stub {
  const real = globalThis.fetch
  const configFetches: string[] = []
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    if (url.includes('/tree/')) return json(tree)
    if (url.includes('/api/models/')) return json({ downloads: 1, likes: 2, tags: [] })
    if (url.endsWith('config.json')) {
      const path = url.split('/resolve/main/')[1]
      configFetches.push(path)
      const cfg = configs[path]
      return cfg ? json(cfg) : new Response('not found', { status: 404 })
    }
    return new Response('# card', { status: 200 })
  }) as typeof fetch
  return { configFetches, restore: () => { globalThis.fetch = real } }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function repoDetail(tree: RawTreeEntry[], configs: Record<string, unknown>, repo = 'AlexWortega/openjev'): Promise<{ detail: HfRepoDetail; stub: Stub }> {
  const stub = stubHf(tree, configs)
  try {
    return { detail: await new HfClient(() => '', '0.0.0-test').getRepo(repo), stub }
  } finally {
    stub.restore()
  }
}

const OPENJEV_TREE: RawTreeEntry[] = [
  file('README.md', 5),
  file('.gitattributes', 1),
  file('assets/demo.mp4', 1_000_000),
  file('openjev/infer.py', 900),
  ...checkpointFolder('qwen3.5-4b-nli-v2', 'sha-v2'),
  file('qwen3.5-4b-nli-v2/chat_template.jinja', 300),
  ...checkpointFolder('qwen3.5-4b-nli-v1', 'sha-v1'),
  ...checkpointFolder('qwen3.5-35b-a3b-nli', 'sha-35b'),
  ...checkpointFolder('qwen3.5-4b-nli-v0', 'sha-v0'),
]

const OPENJEV_CONFIGS = {
  'qwen3.5-4b-nli-v2/config.json': OPENJEV_CONFIG,
  'qwen3.5-4b-nli-v1/config.json': OPENJEV_CONFIG,
  'qwen3.5-35b-a3b-nli/config.json': MOE_CONFIG,
  // qwen3.5-4b-nli-v0 deliberately absent → its config fetch 404s.
}

function jevOf(detail: HfRepoDetail): Record<string, HfCheckpoint['jev']> {
  return Object.fromEntries((detail.checkpoints ?? []).map((c) => [c.dir, c.jev]))
}

test('a multi-checkpoint safetensors repo lists every checkpoint with its own Jev badge', async () => {
  const { detail } = await repoDetail(OPENJEV_TREE, OPENJEV_CONFIGS)

  assert.deepEqual(detail.checkpoints?.map((c) => c.dir), [
    'qwen3.5-35b-a3b-nli', 'qwen3.5-4b-nli-v0', 'qwen3.5-4b-nli-v1', 'qwen3.5-4b-nli-v2',
  ])
  assert.deepEqual(jevOf(detail), {
    'qwen3.5-35b-a3b-nli': { architecture: 'Qwen3_5MoeForSequenceClassification', verified: false },
    'qwen3.5-4b-nli-v0': null,
    'qwen3.5-4b-nli-v1': { architecture: 'Qwen3_5ForSequenceClassification', verified: true },
    'qwen3.5-4b-nli-v2': { architecture: 'Qwen3_5ForSequenceClassification', verified: true },
  })
})

test('the root file list of a multi-checkpoint repo stays empty, exactly as today', async () => {
  const { detail } = await repoDetail(OPENJEV_TREE, OPENJEV_CONFIGS)

  assert.deepEqual(detail.files, [])
  assert.equal(detail.safetensors, true)
})

test('a repo with one root checkpoint keeps today file list, and the checkpoint mirrors it', async () => {
  const tree = [
    file('config.json', 1200),
    file('model.safetensors', 5_000_000_000, 'sha-root'),
    file('tokenizer.json', 7000),
    file('chat_template.jinja', 300),
    file('README.md', 5),
  ]
  const { detail } = await repoDetail(tree, { 'config.json': { architectures: ['Qwen3ForCausalLM'] } }, 'leonsarmiento/Qwen3.6-27B-3bit-mlx')

  assert.equal(detail.checkpoints?.length, 1)
  assert.equal(detail.checkpoints?.[0].dir, '')
  assert.equal(detail.checkpoints?.[0].name, 'Qwen3.6-27B-3bit-mlx')
  assert.deepEqual(detail.checkpoints?.[0].files, detail.files)
  assert.equal(detail.checkpoints?.[0].jev, null)
})

test('at most 16 checkpoint configs are fetched; the rest simply carry no badge', async () => {
  const dirs = Array.from({ length: 17 }, (_, i) => `ckpt-${String(i + 1).padStart(2, '0')}`)
  const tree = dirs.flatMap((dir, i) => checkpointFolder(dir, `sha-${i}`))
  const configs = Object.fromEntries(dirs.map((dir) => [`${dir}/config.json`, OPENJEV_CONFIG]))

  const { detail, stub } = await repoDetail(tree, configs, 'someone/seventeen')

  assert.equal(detail.checkpoints?.length, 17)
  assert.equal(stub.configFetches.length, 16)
  assert.equal(detail.checkpoints?.[16].dir, 'ckpt-17')
  assert.equal(detail.checkpoints?.[16].jev, null)
  assert.deepEqual(detail.checkpoints?.[15].jev, { architecture: 'Qwen3_5ForSequenceClassification', verified: true })
})

test('a GGUF repo has no checkpoints key at all', async () => {
  const tree = [file('qwen3-8b-Q4_K_M.gguf', 4_000_000_000, 'sha-gguf'), file('README.md', 5)]

  const { detail } = await repoDetail(tree, {}, 'bartowski/Qwen3-8B-GGUF')

  assert.equal('checkpoints' in detail, false)
  assert.equal(detail.safetensors, undefined)
})
