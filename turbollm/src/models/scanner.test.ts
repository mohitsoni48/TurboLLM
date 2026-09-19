// Scanner ↔ Jev (ADR-434 (g)): a Jev model folder becomes an ordinary safetensors entry that
// carries a `jev` descriptor. It never claims vision (image premises are untested, ADR-434
// "must not claim") and never claims embedding (it must not take the embedding pool slot,
// ADR-389/427), whatever its config or folder name suggests.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mlxEntryFor } from './scanner'

/** Fixture F1 — the OpenJev config.json fields that matter (plan Appendix). */
function openJevConfig(): Record<string, unknown> {
  return {
    architectures: ['Qwen3_5ForSequenceClassification'],
    model_type: 'qwen3_5',
    id2label: { '0': 'contradiction', '1': 'entailment', '2': 'neutral' },
    label2id: { contradiction: 0, entailment: 1, neutral: 2 },
    nli_template: 'Premise: {premise}\nHypothesis: {hypothesis}',
    vision_config: {},
    max_position_embeddings: 262144,
  }
}

function plainMultimodalConfig(): Record<string, unknown> {
  const cfg = openJevConfig()
  delete cfg.id2label
  delete cfg.architectures
  return cfg
}

/** A model folder named `folderName` holding `config` and one (empty) weights file. */
function withModelFolder(folderName: string, config: unknown, check: (dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'turbollm-jev-'))
  try {
    const dir = join(root, folderName)
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
    writeFileSync(join(dir, 'model.safetensors'), '')
    check(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('an OpenJev folder carries its Jev descriptor and claims neither vision nor embedding', () => {
  withModelFolder('qwen3.5-4b-nli-v2', openJevConfig(), (dir) => {
    const entry = mlxEntryFor(dir)
    assert.deepEqual(entry.jev, {
      labels: ['contradiction', 'entailment', 'neutral'],
      nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
      architecture: 'Qwen3_5ForSequenceClassification',
      verified: true,
    })
    assert.equal(entry.vision, false)
    assert.equal(entry.embedding, false)
  })
})

test('a Jev folder whose name looks like an embedding model is still not an embedding model', () => {
  withModelFolder('qwen3-embedding-nli', openJevConfig(), (dir) => {
    const entry = mlxEntryFor(dir)
    assert.equal(entry.jev?.architecture, 'Qwen3_5ForSequenceClassification')
    assert.equal(entry.embedding, false)
  })
})

test('a Jev entry keeps the arch the scanner already reports (model_type)', () => {
  withModelFolder('qwen3.5-4b-nli-v2', openJevConfig(), (dir) => {
    assert.equal(mlxEntryFor(dir).arch, 'qwen3_5')
  })
})

test('a plain multimodal safetensors folder has no jev key and keeps vision', () => {
  withModelFolder('qwen3.5-4b-chat', plainMultimodalConfig(), (dir) => {
    const entry = mlxEntryFor(dir)
    assert.equal('jev' in entry, false)
    assert.equal(entry.vision, true)
  })
})
