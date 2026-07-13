import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize } from 'node:path'
import { Agent, setGlobalDispatcher } from 'undici'
import { registerApi } from './api/routes'
import { registerChatRoutes } from './chat/chat-routes'
import { registerChatAgentRoutes } from './chat/chat-agent-routes'
import { registerAgentRoutes } from './agents/agent-routes'
import { registerCodeRoutes } from './code/code-routes'
import type { Deps } from './deps'
import { registerGateway } from './gateway/gateway'
import { lanAuth } from './auth'

// Reuse TCP connections for all engine and HF fetch calls. Without this, Node
// opens a new connection per request — ~5–20 ms of extra latency every Claude
// Code turn (it sends back-to-back requests at each agentic step).
setGlobalDispatcher(new Agent({ keepAliveMaxTimeout: 60_000, connections: 10 }))

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'webdist')

// createApp builds the daemon's full HTTP surface (spec 02/03/06/08): health,
// the internal API, the engine gateway, and the embedded React SPA.
export function createApp(d: Deps): Hono {
  const app = new Hono()

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-TurboLLM-Auth'],
    }),
  )
  app.use('*', async (c, next) => {
    c.header('Server', `TurboLLM/${d.version}`)
    await next()
  })

  // LAN auth gate (spec 06 §5): no-op while loopback-only (lanBind=false); once
  // LAN-exposed, requires a valid API key for non-loopback /api/* and /v1/* calls.
  app.use('*', lanAuth(d))

  app.get('/healthz', (c) => c.json({ status: 'ok', version: d.version }))

  registerApi(app, d)
  registerChatRoutes(app, d)
  registerChatAgentRoutes(app, d)
  registerAgentRoutes(app, d)
  registerCodeRoutes(app, d)
  registerGateway(app, d)

  // Embedded SPA with client-side-routing fallback (spec 08 §1).
  app.get('/*', (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, '')
    if (path.startsWith('api/') || path.startsWith('v1/')) {
      return c.json({ error: { code: 'not_found', message: 'Unknown endpoint.' } }, 404)
    }
    let file = normalize(join(WEB_ROOT, path || 'index.html'))
    if (!file.startsWith(WEB_ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(WEB_ROOT, 'index.html')
    }
    if (!existsSync(file)) return c.text('web ui not built — run `npm run build:web`', 500)
    return new Response(readFileSync(file), { status: 200, headers: { 'Content-Type': contentType(file) } })
  })

  return app
}

function contentType(file: string): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
  }
  return map[ext] ?? 'application/octet-stream'
}
