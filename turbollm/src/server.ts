import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, normalize } from 'node:path'
import { Agent, setGlobalDispatcher } from 'undici'
import { registerApi } from './api/routes'
import { registerLinkAdminRoutes } from './api/link-admin-routes'
import { registerChatRoutes } from './chat/chat-routes'
import { registerChatAgentRoutes } from './chat/chat-agent-routes'
import { registerPresetRoutes } from './api/preset-routes'
import { registerAgentRoutes } from './agents/agent-routes'
import type { Deps } from './deps'
import { registerGateway } from './gateway/gateway'
import { featureForPath } from './telemetry/feature-map'
import { registerTerminalRoutes } from './terminal/terminal-routes'
import { registerRoutineRoutes } from './routines/routine-routes'
import { lanAuth, codeAuth } from './auth'
import { registerLinkApi, registerLinkAuth } from './link/link-routes'
import { mountExtApi } from './ext/mount'
import { PublicRunManager } from './ext/run-manager'
import { createMakeBody } from './ext/generation'
import { DEFAULT_AUDIT_RETENTION_DAYS } from './ext/audit'
import { extErrorHandler } from './ext/errors'

// Reuse TCP connections for all engine and HF fetch calls. Without this, Node
// opens a new connection per request — ~5–20 ms of extra latency every Claude
// Code turn (it sends back-to-back requests at each agentic step).
setGlobalDispatcher(new Agent({ keepAliveMaxTimeout: 60_000, connections: 10 }))

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'webdist')

// createApp builds the daemon's full HTTP surface (spec 02/03/06/08): health,
// the internal API, the engine gateway, and the embedded React SPA.
export function createApp(d: Deps): Hono {
  const app = new Hono()

  // Backstop for the "unhandled throw reaches Hono's default handler, which returns a bare,
  // non-JSON text/plain 500" failure class on the external chat API (round 1's C3, round 3's
  // N5/N6-regression fix — each prior fix closed one specific trigger, not the underlying gap).
  // Hono only supports ONE `onError` handler per app instance (confirmed: `compose()` always
  // receives `this.errorHandler` — never undefined, since Hono itself defaults it to its own
  // generic-500 producer — so a per-route-group `try { await next() } catch {}` middleware can
  // NEVER observe a downstream throw; it always resolves normally once Hono's own dispatch layer
  // has already converted the error into a response, well before the rejection could reach a
  // middleware's own `next()` call). `extErrorHandler` (errors.ts) is scoped internally to only
  // reshape `/api/ext/v1/*` responses — see its own doc comment.
  app.onError(extErrorHandler)

  // /v1/* (OpenAI/Anthropic-compatible gateway) stays fully permissive — arbitrary
  // client software (Claude Code, other CLIs/tools) needs to reach it cross-origin,
  // and it carries no browser-fingerprinting surface the way /api/* does.
  app.use(
    '/v1/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-TurboLLM-Auth'],
    }),
  )
  // /api/* origin-allowlisted (ADR-216 open question, resolved): wildcard CORS here let
  // ANY website silently read a loopback user's GPU/CPU/RAM via unauthenticated
  // /api/v1/sysinfo while the daemon runs — a fingerprinting surface, not just the
  // turbollm.dev "Suggest for my hardware" integration it was added to support. Compat
  // swept 2026-07-22: that page (docs/site-build/pages/what-can-i-run.html) is the ONLY
  // real cross-origin /api/* caller in the codebase, running from the production origin.
  // A same-origin request (the app's own served UI) is unaffected either way — the
  // browser never applies CORS to it.
  app.use(
    '/api/*',
    cors({
      origin: 'https://turbollm.dev',
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
  // Code-specific gate (independent of requireApiKey — see auth.ts's codeAuth doc comment):
  // Code always needs a key from a non-host device, even when the rest of the app is open.
  app.use('/api/v1/code/*', codeAuth(d))

  // Turbo Link's own gate (ADR-376). MUST come after lanAuth so an ordinary LAN request is
  // still subject to the normal gate; it is an INVERSION of lanAuth and exempts nothing,
  // including loopback (spec §3.3). Registered here, above the telemetry middleware, so a
  // rejected peer never counts as feature usage — the façade's HANDLERS are registered
  // below it instead (see registerLinkApi).
  registerLinkAuth(app, d)

  // Feature-discovery + feature-engagement telemetry (ADR-299, the latter's
  // wiring added by the telemetry-review follow-up). Runs AFTER the auth gates
  // above, so a request that was rejected never counts as the user discovering
  // or using anything. Only the path is inspected — never the body, never the
  // query string — and the emitter itself decides whether consent permits
  // recording it. `firstUse` answers "did they ever discover this feature";
  // `useFeature` answers "are they still using it" — deliberately both, since
  // discovery data alone can't tell a one-time click from real engagement.
  app.use('*', async (c, next) => {
    const feature = d.telemetry ? featureForPath(c.req.path) : null
    if (feature !== null) {
      d.telemetry?.firstUse(feature)
      d.telemetry?.useFeature(feature)
    }
    await next()
  })

  // Turbo Link façade HANDLERS (ADR-376) — gate already registered above.
  //
  // These must come after the feature-telemetry middleware directly above. Hono composes
  // matching handlers in registration order, so a route handler that returns without
  // calling next() short-circuits every middleware registered later: registered above the
  // telemetry middleware, `POST /api/link/v1/hello` never reached it, and the `link`
  // feature was recorded for exactly one case — a 404 on a path the façade does not serve.
  // A metric that fires only on failures is worse than none. Every future façade route
  // inherits this ordering, so keep the registration here.
  registerLinkApi(app, d, { authAlreadyRegistered: true })

  app.get('/healthz', (c) => c.json({ status: 'ok', version: d.version }))

  registerApi(app, d)
  registerLinkAdminRoutes(app, d)
  registerChatRoutes(app, d)
  registerChatAgentRoutes(app, d)
  registerPresetRoutes(app, d)
  registerAgentRoutes(app, d)
  // Code/Agents routes are registered lazily — see registerCodeRoutesIfSupported below —
  // not here, so createApp() itself never touches that dependency chain.
  registerTerminalRoutes(app, d)
  registerRoutineRoutes(app, d)
  registerGateway(app, d)

  // External chat API (spec 27) — flag-gated off by default (config.ts's `api.ext.enabled`);
  // mountExtApi registers nothing at all when the flag is off, so this is a true no-op for
  // every existing install until an operator opts in. Runs do not RESUME across a restart
  // (spec 27 §6.4) — an in-flight generation is gone with the process either way — but the
  // RECORD must survive, so a client that reconnects after a daemon bounce gets an honest
  // `failed`/`daemon_restarted` answer instead of a 404 that looks like the run never
  // existed. `db: d.db` is what makes `extRuns.reconcileOnStartup()` below operate on the
  // real, persisted `ext_runs` table rather than an always-empty in-memory map (Phase 4
  // Task 1's whole reason for existing). The reaper/prune tick mirrors the pattern already
  // used elsewhere in this codebase for background sweeps (cli.ts's
  // routineScheduler/cliInteractiveSweepTimer): unref'd so a pending tick can never keep the
  // process alive on its own.
  const extRuns = new PublicRunManager({ orphanTimeoutMs: 5 * 60_000, db: d.db })
  extRuns.reconcileOnStartup()
  const ext = mountExtApi(app, d, extRuns, { makeBody: createMakeBody(d) })
  // Release-gate I10: a public run's tools currently run under the LOCAL install's own
  // toolPolicies/autoAllowAll (generation.ts), not an independent trust boundary — a remote
  // tenant's chat can execute run_code/fetch_url (and any configured MCP tool) on installs
  // where those are allow-policy. Shipped as an explicit, logged, EXPERIMENTAL opt-in (not
  // blocked on building a separate ext-specific tool allowlist) rather than silently — an
  // operator enabling this should see the trust-model change called out at the exact moment
  // they turn it on, every time the daemon starts with it enabled.
  if (ext) {
    console.warn(
      '[ext-api] /api/ext/v1 is enabled (EXPERIMENTAL). Remote tenants currently inherit this ' +
      "install's own tool permissions for public generations, including run_code if it's " +
      'allow-policy here — see config.json\'s api.ext doc comment.',
    )
  }
  const extRunsReaper = setInterval(() => {
    extRuns.reapOrphans()
    extRuns.prune(60 * 60_000)
    // Idempotency entries outlive individual runs on purpose (24h default TTL vs the 1h run
    // prune above) — see routes.runs.ts's `idempotency_replay_expired` handling for how a
    // replay of an already-pruned run fails closed instead of double-generating. Still needs
    // its own bound, so expired entries don't accumulate forever.
    ext?.idempotency.prune()
    // The audit trail (spec 27 §10) outlives both of the above by design — "who did what" is
    // exactly the record an operator wants to still have after a run has aged out of the
    // reaper above — but it still needs its own bound so ext_audit doesn't grow forever.
    ext?.audit.prune(DEFAULT_AUDIT_RETENTION_DAYS)
  }, 30_000)
  extRunsReaper.unref()

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

/** Registers the Code/Agents feature's routes, lazily — call once, right after
 *  `createApp()`, before the server starts accepting connections. NOT folded into
 *  `createApp()` itself: `code-routes.ts` imports `code-session.ts`, which statically
 *  imports `@earendil-works/pi-ai`/`pi-coding-agent`, which pull in `pi-tui` and `marked`.
 *  Those use `\p{...}` Unicode-property regex syntax pervasively (emphasis/strikethrough
 *  tokenizing, terminal text width) — TurboLLM Android's embedded `nodejs-mobile` runtime
 *  ships a Node build without full ICU data, and can't even PARSE that syntax (a
 *  module-load-time SyntaxError, not a catchable runtime one — confirmed live, it crashed
 *  the whole daemon before any of its own code ran, see TurboLLM Android's BLUEPRINT.md
 *  Spike D). A dynamic import here means that whole dependency chain is never even
 *  resolved on a platform that can't run it, since Code/Agents needs `node-pty` (also
 *  unavailable there) regardless — skipping registration entirely on Android costs nothing
 *  real. Every other platform's behavior/route surface is unchanged (import resolves
 *  immediately, same handlers as before, still registered in the same relative order
 *  before terminal/routine/gateway/ext — Hono matches by path pattern, not registration
 *  order, so moving this call out of `createApp()`'s synchronous body doesn't change
 *  routing behavior). */
export async function registerCodeRoutesIfSupported(app: Hono, d: Deps): Promise<void> {
  if (process.platform === 'android') return
  // code-routes.ts ships as its OWN tsup entry, in its OWN separate build pass (see
  // tsup.config.ts) — not chunked/shared with cli.js — so this dynamic import can never
  // accidentally pull the pi-coding-agent chain into cli.js's own static output (esbuild's
  // default chunk-splitting did exactly that once, confirmed live). The specifier is built
  // via pathToFileURL(join(...)) rather than `new URL('./relative', import.meta.url)` on
  // purpose — that two-argument form is a recognized esbuild asset-reference idiom (the
  // same one builtin.ts's WORKER_PATH deliberately relies on for `new Worker(url)`) and
  // esbuild resolves/inlines it at BUILD time even inside `import()`, defeating the whole
  // point of a lazy import — also confirmed live, the actual bug this works around.
  const hereFile = fileURLToPath(import.meta.url)
  const isDev = hereFile.endsWith('.ts')
  const modPath = join(dirname(hereFile), isDev ? 'code' : '.', `code-routes${isDev ? '.ts' : '.js'}`)
  const { registerCodeRoutes } = await import(pathToFileURL(modPath).href)
  registerCodeRoutes(app, d, d.codeRuns)
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
