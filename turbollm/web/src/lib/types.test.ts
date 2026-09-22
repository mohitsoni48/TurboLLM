// Shape smoke tests for hand-written daemon↔web type twins (types.ts). These types are erased
// at runtime, so there is nothing to unit-test about them directly — what IS worth asserting is
// that a value shaped the way the daemon actually sends it satisfies the type, which is what
// keeps a future field rename/removal here from silently drifting out of sync with usage-parse.ts
// (see that file's own comment on HwGpuUsage) without tsc catching it in an unrelated file.
import { describe, expect, it } from 'vitest'
import type {
  ActiveWork,
  ClassifyRequest,
  ClassifyResponse,
  HfCheckpoint,
  HfRepoDetail,
  HwDiskUsage,
  HwUsage,
  JevInfo,
  JevStatus,
  ModelEntry,
  RerankRequest,
  RerankResponse,
  Status,
} from './types'

describe('HwUsage.disk (GitHub #211 follow-up)', () => {
  it('accepts a real disk sample', () => {
    const disk: HwDiskUsage = { readMBps: 12.5, writeMBps: 3.25, combined: false }
    const usage: HwUsage = { cpuPct: 10, ram: { usedMb: 1, totalMb: 2 }, gpus: [], disk, sampledAt: Date.now() }
    expect(usage.disk?.readMBps).toBe(12.5)
    expect(usage.disk?.writeMBps).toBe(3.25)
    expect(usage.disk?.combined).toBe(false)
  })

  it('accepts a combined sample — one un-split throughput figure (macOS iostat)', () => {
    const disk: HwDiskUsage = { readMBps: 512, writeMBps: null, combined: true }
    expect(disk.combined).toBe(true)
    expect(disk.writeMBps).toBeNull()
  })

  it('accepts null — no reader for this platform, or no rated sample yet', () => {
    const usage: HwUsage = { cpuPct: null, ram: { usedMb: 1, totalMb: 2 }, gpus: [], disk: null, sampledAt: Date.now() }
    expect(usage.disk).toBeNull()
  })

  it('accepts a partially-null sample (one side of the split unavailable)', () => {
    const disk: HwDiskUsage = { readMBps: 5, writeMBps: null, combined: false }
    expect(disk.writeMBps).toBeNull()
    expect(disk.combined).toBe(false)
  })
})

// Jev twins (ADR-434). Every field below is one the daemon really sends — src/models/jev.ts
// (JevInfo), src/api/jev-status.ts (JevStatus), src/api/active-work.ts (ActiveWork),
// src/hf/checkpoints.ts + the repo-detail overlay (HfCheckpoint) and src/gateway/jev-endpoints.ts
// (classify/rerank). A drift here is only ever caught by tsc, which is why these exist.
describe('Jev wire twins', () => {
  it('accepts the Jev info a scanned model carries', () => {
    const jev: JevInfo = {
      labels: ['contradiction', 'entailment', 'neutral'],
      nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
      architecture: 'Qwen3_5ForSequenceClassification',
      verified: true,
    }
    const onEntry: ModelEntry['jev'] = jev
    expect(onEntry?.labels).toHaveLength(3)
    expect(onEntry?.verified).toBe(true)
  })

  it('accepts an unverified architecture with no usable template', () => {
    const jev: JevInfo = { labels: ['entailment', 'neutral', 'contradiction'], nliTemplate: null, architecture: 'Qwen3_5MoeForSequenceClassification', verified: false }
    expect(jev.nliTemplate).toBeNull()
  })

  it('accepts the incompatibility reason a model row now carries', () => {
    const reason: ModelEntry['incompatibleReason'] = 'Needs vLLM (Linux or WSL2)'
    const none: ModelEntry['incompatibleReason'] = null
    expect(reason).toContain('vLLM')
    expect(none).toBeNull()
  })

  it('accepts the loaded Jev model on status, and its absence', () => {
    const jev: JevStatus = {
      key: 'qwen3.5 4b nli v2|mlx-fp16|9012345678',
      name: 'qwen3.5 4b nli v2',
      labels: ['contradiction', 'entailment', 'neutral'],
      state: 'running',
      slot: 'primary',
    }
    const onStatus: Status['jev'] = jev
    const nothingLoaded: Status['jev'] = null
    expect(onStatus?.slot).toBe('primary')
    expect(nothingLoaded).toBeNull()
  })

  it('accepts the classify request and response of the kitchen example', () => {
    const req: ClassifyRequest = { model: 'm', premise: 'A chef is chopping onions in a busy restaurant kitchen.', hypotheses: ['Someone is preparing food.'] }
    const res: ClassifyResponse = {
      model: 'm',
      results: [{ hypothesis: req.hypotheses[0], label: 'entailment', probs: { contradiction: 0, entailment: 0.957, neutral: 0.043 } }],
      usage: { prompt_tokens: 69, total_tokens: 69 },
    }
    expect(res.results[0].probs.entailment).toBe(0.957)
  })

  it('accepts the rerank request and its Cohere-shaped response', () => {
    const req: RerankRequest = { model: 'm', query: 'What is the capital of France?', documents: ['Berlin', 'Paris'], top_n: 2, hypothesis_template: 'The correct answer is: {}' }
    const res: RerankResponse = {
      model: 'm',
      results: [{ index: 1, document: { text: 'Paris' }, relevance_score: 0.941, label: 'entailment' }],
      usage: { prompt_tokens: 51, total_tokens: 51 },
    }
    expect(req.documents).toHaveLength(2)
    expect(res.results[0].document.text).toBe('Paris')
  })

  it('accepts the three kinds of active work, and an idle daemon', () => {
    const busy: ActiveWork = {
      items: [
        { kind: 'chat', id: 'c1', label: 'Kitchen test' },
        { kind: 'code', id: 's1', label: 'Fix the scanner' },
        { kind: 'routine', id: 'r1', label: 'Summarise my inbox' },
      ],
      engineGenerating: true,
    }
    const idle: ActiveWork = { items: [], engineGenerating: false }
    expect(busy.items.map((i) => i.kind)).toEqual(['chat', 'code', 'routine'])
    expect(idle.engineGenerating).toBe(false)
  })

  it('accepts a checkpoint row, downloaded and not', () => {
    const checkpoint: HfCheckpoint = {
      dir: 'qwen3.5-4b-nli-v2',
      name: 'qwen3.5-4b-nli-v2',
      sizeBytes: 9_000_000_000,
      files: [{ name: 'qwen3.5-4b-nli-v2/model.safetensors', quant: 'mlx', sizeBytes: 9_000_000_000, parts: 1, mmproj: false, safetensors: true, url: 'https://example.invalid/model.safetensors' }],
      jev: { architecture: 'Qwen3_5ForSequenceClassification', verified: true },
      downloaded: true,
      localKey: 'v2-key',
    }
    const notDownloaded: HfCheckpoint = { dir: '', name: 'openjev', sizeBytes: 1, files: [], jev: null, downloaded: false, localKey: null }
    const onDetail: HfRepoDetail['checkpoints'] = [checkpoint, notDownloaded]
    expect(onDetail?.[0].jev?.verified).toBe(true)
    expect(onDetail?.[1].localKey).toBeNull()
  })
})
