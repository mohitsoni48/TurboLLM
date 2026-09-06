/**
 * TurboLLM beta-signup Worker (ADR-401).
 *
 * Two endpoints:
 *   POST /signup         — public, called by turbollm.dev/beta
 *   GET  /admin/signups  — bearer-token, called by the local dashboard.html
 *
 * Deploy:  wrangler secret put ADMIN_TOKEN   (then)   wrangler deploy
 */

// Explicit `.ts` extension (unlike telemetry-worker's extensionless imports):
// esbuild/wrangler accept either, but Node's ESM resolver does not, and this
// Worker is verified by running it directly under `node --experimental-strip-types`
// rather than against a dev server (ADR-401 — no spare ports exist in this project).
import { sendConfirmation } from './email.ts'

interface Env {
  DB: D1Database
  ADMIN_TOKEN?: string
  RESEND_API_KEY?: string
}

/** Cloudflare's execution context. Structurally typed — this Worker has no
 *  `@cloudflare/workers-types` dependency (wrangler bundles it with esbuild and
 *  does not typecheck it), same as telemetry-worker. */
interface Ctx {
  waitUntil(p: Promise<unknown>): void
}

const PLATFORMS = ['windows', 'macos', 'linux', 'android', 'ios'] as const
type Platform = (typeof PLATFORMS)[number]

const LIMITS = {
  name: 80,
  email: 200,
  reason: 2000,
  source: 300,
  body: 8 * 1024,
}
const MIN_REASON = 20

// A form a human fills in by hand. Five in an hour from one address is already
// far past "I made a typo in my email and resubmitted."
const IP_WINDOW_MS = 60 * 60 * 1000
const IP_MAX_IN_WINDOW = 5

// Below this many total signups, nobody is told their queue number — "#3" says
// the list is nearly empty, which is the opposite of what the number is for
// (founder call, ADR-403). The number still exists and the dashboard always
// shows it; it is only withheld from the applicant. One constant to change when
// the list is big enough to be flattering.
const SHOW_POSITION_FROM = 50

// turbollm.dev only, plus Pages preview deploys so a staged page can be tested
// before it is live. Anything else gets no CORS header and the browser drops the
// response — the endpoint is not a secret, but it also should not quietly become
// somebody else's form backend.
function allowOrigin(origin: string | null): string | null {
  if (!origin) return null
  if (origin === 'https://turbollm.dev' || origin === 'https://www.turbollm.dev') return origin
  if (/^https:\/\/[a-z0-9-]+\.turbollm\.pages\.dev$/.test(origin)) return origin
  return null
}

function json(data: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
  const allowed = allowOrigin(origin)
  if (allowed) headers['access-control-allow-origin'] = allowed
  return new Response(JSON.stringify(data), { status, headers })
}

/** The IP is never written down. This hash exists only so the flood check can
 *  recognise "same submitter again" without the table holding an address. */
async function ipHash(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Length-independent comparison so a wrong token cannot be narrowed down by
 *  timing the response. */
function tokenMatches(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

type Parsed = { name: string; email: string; reason: string; platforms: Platform[]; source: string }

function validate(body: Record<string, unknown>): { ok: true; value: Parsed } | { ok: false; error: string } {
  // Honeypot: a real browser leaves this hidden field empty; most naive bots
  // fill every input they find. Cheap, and costs a human nothing (no CAPTCHA).
  if (str(body.website, 100) !== '') return { ok: false, error: 'Submission rejected.' }

  const name = str(body.name, LIMITS.name)
  if (name.length < 2) return { ok: false, error: 'Please enter your name.' }

  const email = str(body.email, LIMITS.email).toLowerCase()
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.' }

  const reason = str(body.reason, LIMITS.reason)
  if (reason.length < MIN_REASON) {
    return { ok: false, error: `Tell us a little more — at least ${MIN_REASON} characters.` }
  }

  const raw = Array.isArray(body.platforms) ? body.platforms : []
  const platforms = [...new Set(raw.filter((p): p is Platform => PLATFORMS.includes(p as Platform)))]
  if (platforms.length === 0) return { ok: false, error: 'Pick at least one platform you can test on.' }

  return { ok: true, value: { name, email, reason, platforms, source: str(body.source, LIMITS.source) } }
}

async function handleSignup(req: Request, env: Env, origin: string | null, ctx?: Ctx): Promise<Response> {
  const raw = await req.text()
  if (raw.length > LIMITS.body) return json({ ok: false, error: 'Submission too large.' }, 413, origin)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return json({ ok: false, error: 'Malformed submission.' }, 400, origin)
  }

  const parsed = validate(body)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400, origin)

  const hash = await ipHash(req)
  const now = Date.now()

  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM signups WHERE ip_hash = ? AND created_at > ?')
    .bind(hash, now - IP_WINDOW_MS)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= IP_MAX_IN_WINDOW) {
    return json({ ok: false, error: 'Too many signups from here. Try again later.' }, 429, origin)
  }

  const { name, email, reason, platforms, source } = parsed.value
  const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? null

  // Re-submitting an address updates that person's answers rather than failing
  // on the UNIQUE constraint — someone correcting their paragraph or adding a
  // platform should not hit an error, and the table stays one-row-per-person.
  const result = await env.DB.prepare(
    `INSERT INTO signups (created_at, updated_at, name, email, reason, platforms, source, country, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       updated_at = excluded.updated_at,
       name       = excluded.name,
       reason     = excluded.reason,
       platforms  = excluded.platforms
     RETURNING id, created_at, updated_at`,
  )
    .bind(now, now, name, email, reason, JSON.stringify(platforms), source || null, country, hash)
    .first<{ id: number; created_at: number; updated_at: number }>()

  const updated = !!result && result.created_at !== result.updated_at

  // The queue number IS the row id, so it is stable forever, never recalculated,
  // and matches what the dashboard shows. Someone correcting their answers keeps
  // the number they already had rather than being sent to the back of the queue.
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM signups').first<{ n: number }>()
  const position = (total?.n ?? 0) >= SHOW_POSITION_FROM ? (result?.id ?? null) : null

  // Only on first registration: a second "welcome" for a corrected typo reads as
  // a broken system. Fired after the response so a mail outage cannot fail a
  // signup — the applicant is already in the table either way.
  if (!updated && result) {
    const deliver = async () => {
      const error = await sendConfirmation(env.RESEND_API_KEY, email, { name, platforms, position })
      await env.DB.prepare('UPDATE signups SET email_sent_at = ?, email_error = ? WHERE id = ?')
        .bind(error ? null : Date.now(), error, result.id)
        .run()
    }
    if (ctx) ctx.waitUntil(deliver())
    else await deliver()
  }

  return json({ ok: true, status: updated ? 'updated' : 'registered', position }, 200, origin)
}

// Every /admin response — success AND failure — goes through here.
//
// `access-control-allow-origin: *` is safe precisely because the gate is a bearer
// header rather than a cookie: no browser attaches it automatically, so there is no
// cross-site request to forge. It has to be `*` because the dashboard is opened from
// disk (file://), which sends `Origin: null`.
//
// The errors need it just as much as the success does. Without it the browser blocks
// the 401 body, `fetch` rejects, and the dashboard reports "could not reach the
// Worker" — a network error for what is really a wrong token. Shipped that way once;
// it cost a debugging session.
function adminJson(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "cache-control": "no-store",
    },
  })
}

async function handleAdmin(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) {
    return adminJson({ ok: false, error: "ADMIN_TOKEN is not configured on this Worker." }, 503)
  }
  // Both sides are trimmed. `Get-Clipboard | wrangler secret put` — the obvious way
  // to set this without the value touching your shell history — pipes a trailing
  // CRLF, so the stored secret ends in whitespace while the dashboard sends the clean
  // string, and every request 401s for no visible reason. Trailing whitespace is never
  // part of a token, so accepting it costs nothing and saves a baffling debug session.
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  if (!given || !tokenMatches(given, env.ADMIN_TOKEN.trim())) {
    return adminJson({ ok: false, error: "Unauthorized." }, 401)
  }

  const { results } = await env.DB.prepare(
    `SELECT id, created_at, updated_at, name, email, reason, platforms, source, country,
            invited_at, notes, email_sent_at, email_error
     FROM signups ORDER BY created_at DESC`,
  ).all()

  return adminJson({ ok: true, count: results.length, signups: results }, 200)
}

export default {
  async fetch(req: Request, env: Env, ctx?: Ctx): Promise<Response> {
    const url = new URL(req.url)
    const origin = req.headers.get('origin')

    if (req.method === 'OPTIONS') {
      const allowed = allowOrigin(origin)
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': url.pathname.startsWith('/admin') ? '*' : (allowed ?? 'null'),
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
          'access-control-max-age': '86400',
        },
      })
    }

    if (url.pathname === '/health') return json({ ok: true }, 200, origin)
    if (url.pathname === '/signup' && req.method === 'POST') return handleSignup(req, env, origin, ctx)
    if (url.pathname === '/admin/signups' && req.method === 'GET') return handleAdmin(req, env)

    return json({ ok: false, error: 'Not found.' }, 404, origin)
  },
}
