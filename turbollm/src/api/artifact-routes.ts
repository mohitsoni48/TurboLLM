// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { join } from 'node:path'
import type { Deps } from '../deps'
import { isLocalRequest } from '../auth'
import { screenshotArtifact, findChrome } from '../artifacts/screenshot'
import { err, body } from './http'

/** Artifact export: a pixel-perfect screenshot of an HTML artifact. */
export function registerArtifactRoutes(app: Hono, d: Deps): void {
  // ---- artifact screenshot (faithful export) ----
  // Pixel-perfect raster of an HTML artifact via a real headless Chrome (ADR-121 follow-up).
  // Local-only (renders arbitrary HTML in a browser); LAN clients fall back to client-side
  // html2canvas. Returns 503 when no system browser is found so the caller falls back too.
  app.get('/api/v1/artifacts/screenshot/available', (c) => c.json({ available: findChrome() !== null }))
  app.post('/api/v1/artifacts/screenshot', async (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Screenshot is local-only.')
    const { html, width } = await body<{ html?: string; width?: number }>(c)
    if (!html || typeof html !== 'string') return err(c, 400, 'bad_request', 'html is required')
    const w = Math.max(360, Math.min(Math.round(width || 1000), 1280))
    const h = Math.max(480, Math.round((w * 800) / 1280))
    const png = await screenshotArtifact(html, { width: w, height: h, runDir: join(d.store.dir(), 'run') })
    if (!png) return err(c, 503, 'no_browser', 'No system Chrome/Chromium/Edge found.')
    return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
  })
}
