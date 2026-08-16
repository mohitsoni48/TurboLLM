// Regression tests for MLX shard-completeness detection (PR #3).
// Bug: incomplete shard downloads caused mlx-lm to crash with
// "ValueError: Missing N parameters" at load time.
// Fix: scanner reads model.safetensors.index.json and checks every listed
// shard exists on disk; sets incomplete=true when any shard is absent.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mlxEntryFor } from './scanner'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `turbollm-mlx-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Create a minimal MLX model directory.
 *  @param presentShards  shard files to actually write to disk
 *  @param indexShards    shards to list in model.safetensors.index.json (undefined = no index)
 */
function setupMlxDir(dir: string, presentShards: string[], indexShards?: string[]): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'llama', num_hidden_layers: 32 }))
  for (const shard of presentShards) {
    writeFileSync(join(dir, shard), '')  // empty file — size 0 is fine for completeness check
  }
  if (indexShards !== undefined) {
    const weightMap: Record<string, string> = {}
    indexShards.forEach((shard, i) => { weightMap[`model.layers.${i}.weight`] = shard })
    writeFileSync(
      join(dir, 'model.safetensors.index.json'),
      JSON.stringify({ weight_map: weightMap }),
    )
  }
}

test('all shards listed in index exist on disk → incomplete=false', () => {
  const dir = makeTmpDir()
  try {
    const shards = ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']
    setupMlxDir(dir, shards, shards)
    assert.equal(mlxEntryFor(dir).incomplete, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('second shard missing from disk → incomplete=true (the regression)', () => {
  const dir = makeTmpDir()
  try {
    const allShards = ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']
    // Only write the first shard — second is in the index but absent on disk
    setupMlxDir(dir, [allShards[0]], allShards)
    assert.equal(mlxEntryFor(dir).incomplete, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Regression: some HF repos embed the chat template in tokenizer_config.json (older
// convention); others ship it as a standalone chat_template.jinja (current convention,
// e.g. leonsarmiento/Qwen3.6-27B-3bit-mlx). Only checking tokenizer_config.json missed
// every repo using the newer convention — hasChatTemplate came back false even when a
// real, valid chat_template.jinja sat right next to it.

test('chat_template embedded in tokenizer_config.json → hasChatTemplate=true', () => {
  const dir = makeTmpDir()
  try {
    setupMlxDir(dir, [])
    writeFileSync(join(dir, 'tokenizer_config.json'), JSON.stringify({ chat_template: '{{ messages }}' }))
    assert.equal(mlxEntryFor(dir).hasChatTemplate, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('standalone chat_template.jinja file, absent from tokenizer_config.json → hasChatTemplate=true', () => {
  const dir = makeTmpDir()
  try {
    setupMlxDir(dir, [])
    writeFileSync(join(dir, 'tokenizer_config.json'), JSON.stringify({ tokenizer_class: 'GPT2Tokenizer' }))
    writeFileSync(join(dir, 'chat_template.jinja'), '{{ messages }}')
    assert.equal(mlxEntryFor(dir).hasChatTemplate, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('neither embedded nor standalone chat template → hasChatTemplate=false', () => {
  const dir = makeTmpDir()
  try {
    setupMlxDir(dir, [])
    writeFileSync(join(dir, 'tokenizer_config.json'), JSON.stringify({ tokenizer_class: 'GPT2Tokenizer' }))
    assert.equal(mlxEntryFor(dir).hasChatTemplate, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// reasoningEffort: same per-file substring check as the GGUF path (gguf.ts's
// GgufMeta.reasoningEffort) — never inferred from model_type/arch.

test('reasoning_effort branch embedded in tokenizer_config.json chat_template → reasoningEffort=true', () => {
  const dir = makeTmpDir()
  try {
    setupMlxDir(dir, [])
    writeFileSync(
      join(dir, 'tokenizer_config.json'),
      JSON.stringify({ chat_template: "{%- set e = reasoning_effort|default('xhigh') %}" }),
    )
    assert.equal(mlxEntryFor(dir).reasoningEffort, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reasoning_effort branch in a standalone chat_template.jinja → reasoningEffort=true', () => {
  const dir = makeTmpDir()
  try {
    setupMlxDir(dir, [])
    writeFileSync(join(dir, 'tokenizer_config.json'), JSON.stringify({ tokenizer_class: 'GPT2Tokenizer' }))
    writeFileSync(join(dir, 'chat_template.jinja'), "{%- set e = reasoning_effort|default('xhigh') %}")
    assert.equal(mlxEntryFor(dir).reasoningEffort, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chat template present but without a reasoning_effort branch → reasoningEffort=false', () => {
  const dir = makeTmpDir()
  try {
    setupMlxDir(dir, [])
    writeFileSync(join(dir, 'tokenizer_config.json'), JSON.stringify({ chat_template: '{{ messages }}' }))
    const entry = mlxEntryFor(dir)
    assert.equal(entry.hasChatTemplate, true)
    assert.equal(entry.reasoningEffort, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Regression: MLX-format models always reported vision=false regardless of config.json,
// unlike GGUF (which detects vision via a paired mmproj file) — so a genuinely
// vision-capable MLX model (e.g. gemma4, which has both vision_config and audio_config)
// never showed up under the Models screen's "Vision" filter tab. audio (a distinct
// capability from vision — a model can have either, both, or neither) was previously
// untracked entirely.

test('config.json with vision_config → vision=true', () => {
  const dir = makeTmpDir()
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'llama', vision_config: {} }))
    const entry = mlxEntryFor(dir)
    assert.equal(entry.vision, true)
    assert.equal(entry.audio, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config.json with audio_config → audio=true', () => {
  const dir = makeTmpDir()
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'gemma4', audio_config: {} }))
    const entry = mlxEntryFor(dir)
    assert.equal(entry.audio, true)
    assert.equal(entry.vision, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config.json with neither vision_config nor audio_config → both false (plain text model)', () => {
  const dir = makeTmpDir()
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'llama' }))
    const entry = mlxEntryFor(dir)
    assert.equal(entry.vision, false)
    assert.equal(entry.audio, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('first shard missing, second present → incomplete=true', () => {
  const dir = makeTmpDir()
  try {
    const allShards = ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']
    setupMlxDir(dir, [allShards[1]], allShards)  // only second shard on disk
    assert.equal(mlxEntryFor(dir).incomplete, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('all shards missing → incomplete=true', () => {
  const dir = makeTmpDir()
  try {
    const allShards = ['model-00001-of-00003.safetensors', 'model-00002-of-00003.safetensors', 'model-00003-of-00003.safetensors']
    setupMlxDir(dir, [], allShards)  // none on disk
    assert.equal(mlxEntryFor(dir).incomplete, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no index file → incomplete=false (single-file or non-sharded model)', () => {
  const dir = makeTmpDir()
  try {
    // Single model.safetensors with no index — common for small models
    setupMlxDir(dir, ['model.safetensors'])
    assert.equal(mlxEntryFor(dir).incomplete, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('malformed index JSON → incomplete=false (best-effort, no throw)', () => {
  const dir = makeTmpDir()
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'llama' }))
    writeFileSync(join(dir, 'model.safetensors.index.json'), 'NOT VALID JSON {{{')
    // Must not throw — best-effort detection
    assert.equal(mlxEntryFor(dir).incomplete, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index with empty weight_map → incomplete=false', () => {
  const dir = makeTmpDir()
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'llama' }))
    writeFileSync(join(dir, 'model.safetensors.index.json'), JSON.stringify({ weight_map: {} }))
    assert.equal(mlxEntryFor(dir).incomplete, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('duplicate shard entries in weight_map only require one file on disk', () => {
  const dir = makeTmpDir()
  try {
    const shard = 'model-00001-of-00001.safetensors'
    // Multiple weight keys point to the same shard file — deduped via Set
    const weightMap = {
      'layer.0.weight': shard,
      'layer.1.weight': shard,
      'layer.2.weight': shard,
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'llama' }))
    writeFileSync(join(dir, 'model.safetensors.index.json'), JSON.stringify({ weight_map: weightMap }))
    writeFileSync(join(dir, shard), '')
    assert.equal(mlxEntryFor(dir).incomplete, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
