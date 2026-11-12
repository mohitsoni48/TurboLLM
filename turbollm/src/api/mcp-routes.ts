// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { McpServer } from '../config/config'
import type { Deps } from '../deps'
import { isLocalOrAuthenticated } from '../auth'
import { err, body } from './http'

/** MCP server management (v0.7.0). */
export function registerMcpRoutes(app: Hono, d: Deps): void {
  // ── MCP server management (v0.7.0) ────────────────────────────────────────

  app.post('/api/v1/mcp/servers', async (c) => {
    // A stdio server is a caller-chosen command the daemon spawns right away (syncMcpServers).
    // Same isLocalOrAuthenticated rule as every other route that executes a caller-supplied
    // program (POST /engines, /engines/scan, /build/*, ADR-394).
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Adding an MCP server requires a valid API key from a non-host device.')
    const b = await body<Partial<McpServer>>(c)
    const transport = b.transport === 'sse' ? 'sse' : 'stdio'
    if (!b.name?.trim()) return err(c, 400, 'invalid_config_value', 'name is required.')
    if (transport === 'stdio' && !b.command?.trim()) return err(c, 400, 'invalid_config_value', 'command is required for stdio transport.')
    if (transport === 'sse' && !b.url?.trim()) return err(c, 400, 'invalid_config_value', 'url is required for sse transport.')
    if (transport === 'sse' && !/^https?:\/\//i.test(b.url ?? '')) return err(c, 400, 'invalid_config_value', 'url must be an http(s):// address.')
    const { randomUUID } = await import('node:crypto')
    const server: McpServer = {
      id: randomUUID(),
      name: b.name.trim(),
      transport,
      enabled: b.enabled !== false,
      ...(transport === 'stdio'
        ? { command: b.command!.trim(), args: b.args ?? [], env: b.env ?? {} }
        : { url: b.url!.trim(), ...(b.apiKey ? { apiKey: b.apiKey } : {}) }),
    }
    // Auto-set MEMORY_FILE_PATH for @modelcontextprotocol/server-memory so users never need to
    // configure it. The package name lands in args (command is "npx"), so check both.
    const isMemoryServer = server.transport === 'stdio' &&
      (server.command?.includes('server-memory') || server.args?.some((a) => a.includes('server-memory')))
    if (isMemoryServer && !server.env?.MEMORY_FILE_PATH) {
      server.env = { ...server.env, MEMORY_FILE_PATH: join(homedir(), '.turbollm', 'mcp-memory.jsonl') }
    }
    d.store.update((cfg) => { cfg.mcp.servers.push(server) })
    if (server.enabled) {
      await d.tools?.syncMcpServers(d.store.snapshot().mcp.servers).catch(() => {})
      await d.tools?.buildToolDefinitions()
    }
    // apiKey is write-only: never echo the Bearer token back, even on the create response.
    // Env values are write-only too (maskMcpEnv).
    const { apiKey: _created, ...safeServer } = server
    return c.json(maskMcpEnv(safeServer), 201)
  })

  app.put('/api/v1/mcp/servers/:id', async (c) => {
    // Can swap in a new command and respawns it — same rule as the create route above.
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Editing an MCP server requires a valid API key from a non-host device.')
    const id = c.req.param('id')
    const b = await body<Partial<McpServer>>(c)
    const cfg = d.store.snapshot()
    if (!cfg.mcp.servers.some((s) => s.id === id)) return err(c, 404, 'not_found', 'MCP server not found.')
    if (b.transport && b.transport !== 'stdio' && b.transport !== 'sse') return err(c, 400, 'invalid_config_value', 'transport must be stdio or sse.')
    if (b.url && !/^https?:\/\//i.test(b.url)) return err(c, 400, 'invalid_config_value', 'url must be an http(s):// address.')
    d.store.update((c2) => {
      const s = c2.mcp.servers.find((x) => x.id === id)!
      if (b.name !== undefined) s.name = b.name.trim()
      if (b.transport !== undefined) s.transport = b.transport
      if (b.enabled !== undefined) s.enabled = !!b.enabled
      if (b.command !== undefined) s.command = b.command
      if (b.args !== undefined) s.args = b.args
      // Env values go out masked (maskMcpEnv), so the edit form sends a value it never saw as
      // MCP_ENV_MASK: that keeps the stored one. A key left out is removed, as before.
      if (b.env !== undefined) s.env = mergeMcpEnv(s.env, b.env)
      if (b.url !== undefined) {
        // A stored Bearer key belongs to the service it was issued by. The key is write-only, so
        // the edit form always opens with a blank key field, and pointing the URL at another host
        // without typing a new key sent apiKey undefined, which kept the old key: the old service's
        // token then went to the new host as Authorization: Bearer (mcp-client.ts). A move to
        // another origin with no new key now drops it; a new path on the same origin keeps it.
        if (b.apiKey === undefined && s.apiKey && !sameUrlOrigin(s.url, b.url)) s.apiKey = undefined
        s.url = b.url
      }
      if (b.apiKey !== undefined) s.apiKey = b.apiKey || undefined
    })
    await d.tools?.syncMcpServers(d.store.snapshot().mcp.servers).catch(() => {})
    await d.tools?.buildToolDefinitions()
    // apiKey is write-only: strip the Bearer token from the update response too, and mask env.
    const updated = d.store.snapshot().mcp.servers.find((s) => s.id === id)!
    const { apiKey: _updated, ...safeUpdated } = updated
    return c.json(maskMcpEnv(safeUpdated))
  })

  app.delete('/api/v1/mcp/servers/:id', async (c) => {
    // Removes a server the owner set up and stops its process — the same rule as the create and
    // edit routes above, which a keyless Serve identity, Access JWT or open-LAN peer is refused.
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Deleting an MCP server requires a valid API key from a non-host device.')
    const id = c.req.param('id')
    const cfg = d.store.snapshot()
    if (!cfg.mcp.servers.some((s) => s.id === id)) return err(c, 404, 'not_found', 'MCP server not found.')
    d.store.update((c2) => { c2.mcp.servers = c2.mcp.servers.filter((s) => s.id !== id) })
    void d.tools?.syncMcpServers(d.store.snapshot().mcp.servers)
    await d.tools?.buildToolDefinitions()
    return c.json({ ok: true })
  })
}

/** What every value of an MCP stdio server's env reads as over the wire (settings payload, the
 *  POST/PUT /mcp/servers responses). Env is where MCP servers take their credentials (the
 *  catalog's BRAVE_API_KEY, MYSQL_PASSWORD, HUGGINGFACE_TOKEN, …), and it went out in clear text,
 *  while every other secret in the payload is write-only: even a keyless open-LAN peer, which may
 *  not edit or spawn MCP servers, read them from GET /settings. The key names stay, so the edit
 *  form can list them. web/src/lib/api.ts has the same string. */
export const MCP_ENV_MASK = '••••••••'

export function maskMcpEnv<T extends { env?: Record<string, string> }>(s: T): T {
  return s.env ? { ...s, env: Object.fromEntries(Object.keys(s.env).map((k) => [k, MCP_ENV_MASK])) } : s
}

/** PUT /mcp/servers/:id's env: the sent map replaces the stored one (a key left out is removed),
 *  except that a key sent with MCP_ENV_MASK keeps its stored value; with none stored, it is
 *  dropped (there is nothing to keep). */
function mergeMcpEnv(stored: Record<string, string> | undefined, sent: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(sent ?? {})) {
    if (v !== MCP_ENV_MASK) out[k] = v
    else if (stored && Object.hasOwn(stored, k)) out[k] = stored[k]
  }
  return out
}

/** True when an MCP server's new URL is on the same origin (scheme, host, port) as its old one,
 *  so its stored Bearer key may stay. A URL that does not parse counts as the same origin only
 *  when it is the same string. */
function sameUrlOrigin(oldUrl: string | undefined, newUrl: string): boolean {
  try {
    return new URL(oldUrl ?? '').origin === new URL(newUrl).origin
  } catch {
    return oldUrl === newUrl
  }
}
