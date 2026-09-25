// Which loaded model the System One playground runs against: the Jev model when one is loaded (it owns the
// Workspace), otherwise the Laya model (ADR-443). Status is the authority; the catalog is the fallback for a
// client that cannot read /status (ADR-422).
import { describe, expect, it } from 'vitest'
import { loadedSystemOneModel } from './systemone-model'
import type { JevInfo, JevStatus, LayaStatus, ModelEntry, Status } from './types'

const JEV_INFO: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}
const JEV: JevStatus = { key: 'jev|mlx-fp16|1', name: 'jev', labels: JEV_INFO.labels, state: 'running', slot: 'primary' }
const LAYA: LayaStatus = { key: 'laya|laya|1455', name: 'laya', checkpoints: ['english', 'multilingual'], state: 'running' }

function status(fields: Partial<Status>): Status {
  return fields as Status
}

describe('loadedSystemOneModel', () => {
  it('is the Jev model when the daemon reports one', () => {
    expect(loadedSystemOneModel(status({ jev: JEV, laya: LAYA }), undefined)).toEqual(JEV)
  })

  it('is the Laya model, in its pool slot and with its checkpoints, when no Jev model is loaded', () => {
    expect(loadedSystemOneModel(status({ jev: null, laya: LAYA }), undefined)).toEqual({
      key: LAYA.key, name: LAYA.name, labels: [], checkpoints: LAYA.checkpoints, state: 'running', slot: 'pool',
    })
  })

  it('is nothing when the daemon reports neither, whatever the catalog says', () => {
    const catalog = [{ key: 'x', name: 'x', laya: { checkpoints: ['english'] }, loaded: true } as ModelEntry]
    expect(loadedSystemOneModel(status({ jev: null, laya: null }), catalog)).toBeNull()
  })

  it('falls back to a loaded Jev model in the catalog when the status cannot be read', () => {
    const catalog = [{ key: JEV.key, name: JEV.name, jev: JEV_INFO, loaded: true } as ModelEntry]
    expect(loadedSystemOneModel(undefined, catalog)).toEqual({
      key: JEV.key, name: JEV.name, labels: JEV_INFO.labels, state: 'running', slot: null,
    })
  })

  it('falls back to a loaded Laya model in the catalog when the status cannot be read', () => {
    const catalog = [{ key: LAYA.key, name: LAYA.name, laya: { checkpoints: ['english'] }, loaded: true } as ModelEntry]
    expect(loadedSystemOneModel(undefined, catalog)).toEqual({
      key: LAYA.key, name: LAYA.name, labels: [], checkpoints: ['english'], state: 'running', slot: 'pool',
    })
  })
})
