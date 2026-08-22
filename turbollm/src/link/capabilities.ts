import type { ApiKey } from '../config/config'
import type { LinkCapability } from './types'

/** Does this key carry `cap`?
 *
 *  Three cases, and the middle one is the one that matters:
 *  - no key at all → false (fail closed)
 *  - key with NO grant → true (every key created before Turbo Link is full-access;
 *    defaulting these to "nothing" would silently revoke the user's existing keys)
 *  - key WITH a grant → exactly what the grant lists. An empty array grants nothing,
 *    and is deliberately distinct from an absent grant. */
export function hasCapability(key: ApiKey | undefined, cap: LinkCapability): boolean {
  if (!key) return false
  if (!key.grant) return true
  return key.grant.capabilities.includes(cap)
}

/** May this key address `modelKey`?
 *  Absent grant → yes. Absent or empty allowlist → yes (the spec's default is "all local
 *  models"). Otherwise an EXACT match only — never a prefix or substring test, so the
 *  fuzzy matching in ModelRouter.resolveEntry can never widen an allowlist. */
export function allowsModel(key: ApiKey | undefined, modelKey: string): boolean {
  if (!key) return false
  if (!key.grant) return true
  const list = key.grant.models
  if (!list || list.length === 0) return true
  return list.includes(modelKey)
}

/** The three presets offered in the mint UI (spec §6.1). "Customize" exposes the raw
 *  checkboxes; these exist so the common cases are one click and stay comprehensible. */
export const LINK_PRESETS: Record<'inference' | 'server' | 'full', LinkCapability[]> = {
  inference: ['models:use'],
  server: ['models:use', 'models:wake', 'models:load', 'models:unload'],
  full: [
    'models:use', 'models:wake', 'models:load', 'models:unload',
    'downloads:read', 'downloads:write', 'config:read', 'config:write',
  ],
}
