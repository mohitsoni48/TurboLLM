import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'
import { linkAuth } from './link-auth'
import { LINK_API_VERSIONS } from './protocol'
import { LINK_CAPABILITIES, type HelloResponse } from './types'

// linkAuth (link-auth.ts) puts the resolved key on the context as `linkKey`, but the
// plain `Hono` type in this function's signature carries no Variables — so route
// handlers below see it through this narrowed local alias rather than widening the
// exported signature (which task 6's interface pins to `Hono`).
type LinkEnv = { Variables: { linkKey: ApiKey } }

/** Stable identity for THIS install, minted once and persisted. The peer keeps it so it
 *  can tell "the tunnel URL changed but it's the same box" (normal, every Kaggle session)
 *  from "this URL now points at a DIFFERENT box" (needs a warning, not a silent adopt). */
export function machineId(d: Deps): string {
  const daemon = d.store.snapshot().daemon as { machineId?: string }
  if (daemon.machineId) return daemon.machineId
  const id = randomUUID()
  d.store.update((cfg) => {
    ;(cfg.daemon as unknown as { machineId?: string }).machineId ??= id
  })
  return id
}

/** Mount the Turbo Link façade (ADR-376).
 *
 *  Deliberately NARROW and explicitly versioned: this is the contract two
 *  independently-updated TurboLLM installs agree on. Routes added here mount EXISTING
 *  handlers behind requireCapability — never reimplement a handler, or the façade
 *  becomes a fork that drifts from the internal API it mirrors.
 *
 *  Register AFTER lanAuth in server.ts. linkAuth then exempts nothing (spec §3.3). */
export function registerLinkApi(app: Hono, d: Deps): void {
  const linkApp = app as unknown as Hono<LinkEnv>
  linkApp.use('/api/link/v1/*', linkAuth(d))

  linkApp.post('/api/link/v1/hello', (c) => {
    const key = c.get('linkKey')
    // A legacy key (no grant) is full-access, so it must report EVERY capability —
    // reporting [] would grey out every control on the peer for an otherwise valid key.
    const capabilities = key.grant ? key.grant.capabilities : [...LINK_CAPABILITIES]
    const models = key.grant?.models?.length ? key.grant.models : undefined
    const daemon = d.store.snapshot().daemon as { machineName?: string }
    const body: HelloResponse = {
      machineId: machineId(d),
      machineName: daemon.machineName || 'TurboLLM',
      appVersion: d.version,
      linkApiVersions: [...LINK_API_VERSIONS],
      capabilities,
      ...(models ? { models } : {}),
    }
    return c.json(body)
  })
}
