import type { AddEngineInput } from './api'
import type { CatalogEngine } from './types'

/** The request that re-registers a catalog card's built-but-disabled engine. It must carry the
 *  card's whole build identity: a pinned card matches its engine on repo + commit + patch, so an
 *  engine registered without them belongs to no card and the card keeps saying "not installed". */
export function enableRequestFor(card: CatalogEngine): AddEngineInput {
  return {
    binPath: card.sourceBinPath ?? '',
    name: card.name,
    sourceRepo: card.homepage,
    sourceBranch: card.sourceBranch || undefined,
    sourceCommit: card.sourceCommit,
    sourcePatchUrl: card.patchUrl,
  }
}
