// The Python sandbox runtime (GitHub #52): read its state, download it, cancel the download, remove it.
import type { Hono, MiddlewareHandler } from 'hono'
import type { Deps } from '../deps'
import { isLocalOrAuthenticated } from '../auth'
import { isSandboxEnabled, SANDBOX_DISABLED, SANDBOX_UNSUPPORTED, sandboxSupported } from '../sandbox/gate'
import { SandboxRuntimeError } from '../sandbox/runtime-install'
import { err } from './http'

export function registerSandboxRuntimeRoutes(app: Hono, d: Deps): void {
  // Same rule as engine installs (engine-release-routes.ts): a download of programs onto this machine comes from the
  // app itself, and from the host or a caller with a valid key.
  const guard: MiddlewareHandler = async (c, next) => {
    if (!sandboxSupported() || !d.sandboxRuntime) return c.json(SANDBOX_UNSUPPORTED, 501)
    if (c.req.method !== 'GET') {
      const site = c.req.header('sec-fetch-site')
      if (site && site !== 'same-origin' && site !== 'none') return err(c, 403, 'forbidden', 'Sandbox downloads must come from the TurboLLM app itself.')
      if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'forbidden', 'Changing the sandbox runtime requires a valid API key from a non-host device.')
    }
    await next()
  }

  app.get('/api/v1/sandbox/runtime', guard, (c) => c.json({ enabled: isSandboxEnabled(d), ...d.sandboxRuntime!.view() }))

  // Starts the download and answers at once; the Settings screen follows it through GET and the sandboxRuntime event.
  app.post('/api/v1/sandbox/runtime/install', guard, (c) => {
    if (!isSandboxEnabled(d)) return c.json(SANDBOX_DISABLED, 403)
    const rt = d.sandboxRuntime!
    if (!rt.view().supported) return c.json(SANDBOX_UNSUPPORTED, 501)
    const already = rt.view().installed !== null
    void rt.install()
    return c.json({ enabled: true, ...rt.view() }, already ? 200 : 202)
  })

  // Cancel and Remove stay reachable with the flag off: turning the sandbox off must never strand a download or the disk it uses.
  app.delete('/api/v1/sandbox/runtime/install', guard, (c) => {
    d.sandboxRuntime!.cancel()
    return c.json({ enabled: isSandboxEnabled(d), ...d.sandboxRuntime!.view() })
  })

  app.delete('/api/v1/sandbox/runtime', guard, async (c) => {
    try {
      // A running Deno holds its own binary open (Windows refuses to delete it) and reads the Pyodide folder.
      await d.sandbox?.closeAll()
      await d.sandboxRuntime!.remove()
    } catch (e) {
      if (e instanceof SandboxRuntimeError) return err(c, 409, e.code, e.message)
      throw e
    }
    return c.json({ enabled: isSandboxEnabled(d), ...d.sandboxRuntime!.view() })
  })
}
