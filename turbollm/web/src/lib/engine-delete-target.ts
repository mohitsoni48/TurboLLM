import type { Engine } from './types'

/** What the delete-confirmation dialog names, and which registry entry it purges. */
export interface DeleteTarget {
  name: string
  registryId: string
  binPath?: string
}

/** The dialog must describe the REGISTERED engine that will be purged, never the catalog card that
 *  happened to claim it. A card claims any registration of its repo on the default branch, and once
 *  one is deleted it claims the next; a card-named dialog looks identical both times and invites a
 *  second click that silently destroys a second build. */
export function deleteTargetFor(registryId: string, registry: Engine[], cardName: string): DeleteTarget {
  const engine = registry.find((e) => e.id === registryId)
  return { name: engine?.name ?? cardName, registryId, binPath: engine?.binPath }
}
