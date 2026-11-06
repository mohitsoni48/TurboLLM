// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Context, Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { ApiKey } from '../config/config'
import type { Deps } from '../deps'
import { getLanIp } from '../net'
import { endStaleStreams, generateApiKey, hostGate, isLocalRequest } from '../auth'
import { localDaemonOrigin } from '../daemon-pid'
import { dropStaleTerminalSockets } from '../terminal/terminal-routes'
import { err, body } from './http'

/** GET /api/v1/settings/network: the LAN exposure the keys and connect pages read. */
export function registerNetworkInfoRoutes(app: Hono, d: Deps): void {
  // ── network info (spec 08 §2): LAN expose state + the reachable LAN URL + whether
  // an API key exists (non-local access requires one). `requireApiKey` + `isHost` (added
  // alongside the /api/v1/keys host gate above) let the UI honestly reflect that same rule
  // instead of just hiding a button while the underlying route is still reachable.
  app.get('/api/v1/settings/network', (c) => {
    const cfg = d.store.snapshot()
    return c.json({
      lanBind: cfg.daemon.lanBind,
      lanUrl: `http://${getLanIp() ?? '127.0.0.1'}:${d.bindPort ?? cfg.daemon.port}`, // the port really bound
      hasApiKey: cfg.apiKeys.length > 0,
      requireApiKey: cfg.daemon.requireApiKey,
      isHost: isLocalRequest(c, d),
    })
  })
}

/** API keys and the CLI connect snippets. */
export function registerKeysConnectRoutes(app: Hono, d: Deps): void {
  // ── API keys (spec 06 §5) ────────────────────────────────────────────────
  // Host-only while the LAN is open and unauthenticated — see auth.ts's `hostGate` for the
  // full rationale. It lives there, not here, so Turbo Link's credential routes
  // (link-admin-routes.ts) share the one predicate instead of re-deriving it (ADR-376).
  function keysHostGate(c: Context): boolean {
    return hostGate(c, d)
  }

  app.get('/api/v1/keys', (c) => {
    if (!keysHostGate(c)) return err(c, 403, 'forbidden', 'API keys are only visible from this machine until "Require an API key" is turned on.')
    const keys = d.store.snapshot().apiKeys.map(({ id, name, prefix, createdAt, lastUsedAt }) => ({
      id,
      name,
      prefix,
      createdAt,
      lastUsedAt,
    }))
    return c.json({ keys })
  })

  app.post('/api/v1/keys', async (c) => {
    if (!keysHostGate(c)) return err(c, 403, 'forbidden', 'API keys can only be created from this machine until "Require an API key" is turned on.')
    const b = await body<{ name?: string }>(c)
    const name = (b.name ?? '').trim()
    if (!name) return err(c, 400, 'invalid_config_value', 'name is required.')
    const { full, hash, prefix } = generateApiKey()
    const key: ApiKey = {
      id: randomUUID(),
      name,
      hash,
      prefix,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    }
    d.store.update((cfg) => cfg.apiKeys.push(key))
    return c.json(
      { key: full, meta: { id: key.id, name: key.name, prefix, createdAt: key.createdAt, lastUsedAt: null } },
      201,
    )
  })

  app.delete('/api/v1/keys/:id', (c) => {
    // Same host gate as GET/POST above (found missing here in the v1.9.0 pre-release review):
    // without it, a non-host device on an open, unauthenticated LAN could revoke ANY key by id —
    // breaking another device's already-configured access — protected by nothing but an
    // unguessable UUID rather than an actual credential check.
    if (!keysHostGate(c)) return err(c, 403, 'forbidden', 'API keys can only be revoked from this machine until "Require an API key" is turned on.')
    const id = c.req.param('id')
    d.store.update((cfg) => {
      cfg.apiKeys = cfg.apiKeys.filter((k) => k.id !== id)
    })
    // A Code terminal opened with this key was checked only at its handshake: close it too, and so
    // is a stream it opened (the logs, a Code session's run).
    dropStaleTerminalSockets(d)
    endStaleStreams(d)
    return c.json({ ok: true })
  })

  // ── CLI connect snippets (spec 06 §6) ────────────────────────────────────
  // Same host gate as /api/v1/keys above, and for the same reason — arguably more urgent here:
  // this route doesn't just expose existing key metadata, it MINTS a brand-new live key (below)
  // and returns its full raw value embedded in the setup snippets on every single call while
  // lanBind is on, with no action beyond loading the page (ConnectSection queries it eagerly for
  // the default-selected CLI). Ungated, a non-host viewer on an open, unauthenticated LAN could
  // get a real credential just by opening Developer — worse than the list/create case, since it
  // requires no explicit "create" click at all. lanAuth (auth.ts) also refuses it cross-site and
  // without the `X-TurboLLM-UI` header the web UI sends, as it replaces a key on a plain GET.
  app.get('/api/v1/connect/:cli', (c) => {
    if (!keysHostGate(c)) return err(c, 403, 'forbidden', 'Connect setup is only available from this machine until "Require an API key" is turned on.')
    const cli = c.req.param('cli')
    const cfg = d.store.snapshot()
    const { lanBind } = cfg.daemon
    const port = d.bindPort ?? cfg.daemon.port // the port really bound (see GET /network's lanUrl)
    // Off the LAN, the loopback address the daemon is bound to when that is not 127.0.0.1 (`--addr [::1]:6996`,
    // where nothing answers on 127.0.0.1: localDaemonOrigin).
    const base = lanBind ? `http://${getLanIp() ?? '127.0.0.1'}:${port}` : localDaemonOrigin(d.bindHost, port)
    const ms = d.manager.status()
    const modelName = ms.state === 'running' ? (ms.model?.name ?? 'local') : 'local'
    const modelKey = ms.state === 'running' ? (ms.model?.key ?? modelName) : modelName

    let apiKey = 'not-needed-on-localhost'
    if (lanBind) {
      // `?mint=0`: the Connect page fetching on its own because it last read the daemon as
      // loopback-only. That read can be stale (LAN switched on from another window while the page
      // stayed open), and minting here would revoke the key a CLI is already using. Refuse; the
      // page re-reads the network info and offers its explicit "Generate" instead.
      if (c.req.query('mint') === '0') return err(c, 409, 'lan_bound', 'LAN sharing is on, so setup snippets carry a new key: generate them explicitly.')
      const keyName = `cli-${cli}`
      const { full, hash, prefix } = generateApiKey()
      const fresh: ApiKey = {
        id: randomUUID(),
        name: keyName,
        hash,
        prefix,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      }
      d.store.update((cfgMut) => {
        cfgMut.apiKeys = cfgMut.apiKeys.filter((k) => k.name !== keyName)
        cfgMut.apiKeys.push(fresh)
      })
      // The replaced key is revoked: a Code terminal or a stream opened with it closes (see DELETE /keys/:id).
      dropStaleTerminalSockets(d)
      endStaleStreams(d)
      apiKey = full
    }

    return c.json(buildConnectSnippets(cli, base, apiKey, modelName, modelKey))
  })
}

// ── CLI connect snippet builders ───────────────────────────────────────────

type ConnectStep = { label: string; snippet: string; lang: string }
type ConnectResult = { cli: string; title: string; steps: ConnectStep[] }

export function buildConnectSnippets(cli: string, base: string, apiKey: string, modelName: string, modelKey: string = modelName): ConnectResult {
  switch (cli) {
    case 'claude-code':
      return {
        cli,
        title: 'Claude Code',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch claude`,
            lang: 'bash',
          },
          {
            label: 'PowerShell one-liner',
            snippet: `$env:ANTHROPIC_BASE_URL="${base}"; $env:ANTHROPIC_AUTH_TOKEN="${apiKey}"; $env:ANTHROPIC_MODEL="${modelName}"; claude`,
            lang: 'powershell',
          },
          {
            label: 'bash / zsh',
            snippet: `ANTHROPIC_BASE_URL="${base}" ANTHROPIC_AUTH_TOKEN="${apiKey}" ANTHROPIC_MODEL="${modelName}" claude`,
            lang: 'bash',
          },
        ],
      }
    case 'opencode':
      return {
        cli,
        title: 'opencode',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch opencode`,
            lang: 'bash',
          },
          {
            label: 'Merge into ~/.config/opencode/opencode.json',
            snippet: JSON.stringify(
              {
                provider: {
                  turbollm: {
                    npm: '@ai-sdk/openai-compatible',
                    options: {
                      baseURL: `${base}/v1`,
                      ...(apiKey !== 'not-needed-on-localhost' ? { apiKey } : {}),
                    },
                    models: { [modelName]: { id: modelName } },
                  },
                },
              },
              null,
              2,
            ),
            lang: 'json',
          },
        ],
      }
    case 'kilo':
      return {
        cli,
        title: 'Kilo Code',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch kilo`,
            lang: 'bash',
          },
          {
            label: 'Add to ~/.config/kilo/kilo.jsonc providers array',
            snippet: JSON.stringify(
              {
                id: 'turbollm',
                name: 'TurboLLM (local)',
                type: 'openai-compatible',
                baseURL: `${base}/v1`,
                apiKey: apiKey !== 'not-needed-on-localhost' ? apiKey : 'not-required',
                models: [{ id: modelName, name: modelName }],
              },
              null,
              2,
            ),
            lang: 'jsonc',
          },
        ],
      }
    case 'openclaw':
      return {
        cli,
        title: 'openclaw',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch openclaw`,
            lang: 'bash',
          },
          {
            label: 'Merge into ~/.config/openclaw/openclaw.json',
            snippet: JSON.stringify(
              {
                models: {
                  providers: {
                    turbollm: {
                      baseUrl: `${base}/v1`,
                      apiKey: apiKey !== 'not-needed-on-localhost' ? apiKey : 'not-required',
                      api: 'openai-completions',
                      models: [{ id: modelKey, name: modelName }],
                    },
                  },
                },
                agents: { defaults: { model: { primary: `turbollm/${modelKey}` } } },
              },
              null,
              2,
            ),
            lang: 'json',
          },
        ],
      }
    case 'hermes':
      return {
        cli,
        title: 'Hermes Agent',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch hermes`,
            lang: 'bash',
          },
          {
            label: 'PowerShell',
            snippet: `hermes config set model.provider custom; hermes config set model.base_url ${base}/v1; hermes config set model.default "${modelKey}"`,
            lang: 'powershell',
          },
          {
            label: 'bash / zsh',
            snippet: `hermes config set model.provider custom && hermes config set model.base_url ${base}/v1 && hermes config set model.default "${modelKey}"`,
            lang: 'bash',
          },
        ],
      }
    case 'qwen':
      return {
        cli,
        title: 'Qwen Code',
        steps: [
          {
            label: 'PowerShell one-liner',
            snippet: `$env:OPENAI_BASE_URL="${base}/v1"; $env:OPENAI_API_KEY="${apiKey}"; $env:OPENAI_MODEL="${modelName}"; qwen`,
            lang: 'powershell',
          },
          {
            label: 'bash / zsh',
            snippet: `OPENAI_BASE_URL="${base}/v1" OPENAI_API_KEY="${apiKey}" OPENAI_MODEL="${modelName}" qwen`,
            lang: 'bash',
          },
        ],
      }
    default:
      return { cli, title: cli, steps: [] }
  }
}
