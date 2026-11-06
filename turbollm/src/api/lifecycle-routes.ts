// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { gateNodeSource } from '../comfyui/gate-template'
import type { Deps } from '../deps'
import { isLocalOrAuthenticated } from '../auth'
import { restartEngine, startEngine, stopEngine, type EngineStartBody, type EngineStopBody } from '../services/engine-lifecycle'
import { err, body } from './http'

/** Engine start/stop/restart, the ComfyUI GPU gate, and the daemon restart and flush. */
export function registerLifecycleRoutes(app: Hono, d: Deps): void {
  // ---- lifecycle (A2) ----
  // The lifecycle handlers live in engine-lifecycle.ts, not here (restart's beside the load it
  // mirrors): the Turbo Link façade (/api/link/v1/models/load and /unload) mounts the SAME
  // start and stop functions behind requireCapability, so a linked peer gets identical
  // eviction / keep-N / ComfyUI-guard / swap-serialization behaviour instead of a second,
  // drifting implementation.
  app.post('/api/v1/engine/start', async (c) => startEngine(c, d, await body<EngineStartBody>(c)))

  app.post('/api/v1/engine/stop', async (c) => stopEngine(c, d, await body<EngineStopBody>(c)))

  app.post('/api/v1/engine/restart', (c) => restartEngine(c, d))

  // ---- ComfyUI GPU gate (push coordination) ----
  // The installed ComfyUI node calls these. acquire() blocks until VRAM is freed so
  // ComfyUI can safely start; release() reloads the model. Both are loopback calls
  // from the local ComfyUI process (lanAuth exempts loopback — no key needed).
  app.post('/api/v1/comfyui/acquire', async (c) => {
    if (!d.comfy) return c.json({ ok: true, held: false })
    await d.comfy.acquire()
    return c.json({ ok: true, ...d.comfy.snapshot() })
  })

  app.post('/api/v1/comfyui/release', (c) => {
    // Answered once loads are unblocked, not after the reload: the gate node (v3+) holds its lock across this call,
    // and a prompt queued meanwhile waits for that lock on ComfyUI's server thread, so every "Run (Instant)" iteration
    // froze ComfyUI until the LLM had reloaded (up to the node's 10 s timeout). release() logs a failed reload itself
    // and never rejects.
    if (d.comfy) void d.comfy.release()
    return c.json({ ok: true })
  })

  // In-app installer (ADR: one-time setup): write the push-gate node into the user's
  // ComfyUI custom_nodes dir, with TurboLLM's own URL baked in. `path` is the ComfyUI
  // folder (or its custom_nodes dir). The URL is the address and port the listener is
  // really bound to (see below), so it's correct even when started with --port.
  //
  // Install and uninstall are host-side changes held to isLocalOrAuthenticated, like MCP servers and
  // builds: install writes the node's __init__.py into any custom_nodes folder the caller names
  // (replacing one there) and records that folder as gatePath, and uninstall deletes gatePath
  // recursively, so a keyless Serve identity, Access JWT or open-LAN peer could remove the owner's
  // working gate (renders then run with the LLM still in VRAM) or delete a folder it pointed gatePath
  // at. api_key_required: the web client opens its key prompt on it. /comfyui/acquire and /release
  // stay open: the gate node calls them with no key.
  app.post('/api/v1/comfyui/install', async (c) => {
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'api_key_required', 'Installing the ComfyUI gate node requires a valid API key.')
    const b = await body<{ path?: string }>(c)
    const raw = (b.path ?? '').trim()
    if (!raw) return err(c, 400, 'invalid_config_value', 'Enter the path to your ComfyUI folder.')

    const root = resolve(raw)
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return err(c, 400, 'invalid_config_value', 'That folder does not exist.')
    }
    // Accept either the ComfyUI root (contains custom_nodes) or the custom_nodes dir.
    let customNodes: string
    if (basename(root).toLowerCase() === 'custom_nodes') customNodes = root
    else if (existsSync(join(root, 'custom_nodes'))) customNodes = join(root, 'custom_nodes')
    else {
      return err(c, 400, 'invalid_config_value', "No 'custom_nodes' folder here. Point me at your ComfyUI folder or its custom_nodes folder.")
    }

    // TurboLLM's origin as the ComfyUI process on this machine reaches it: the address the listener is bound to when
    // that is one address (`--addr 192.168.1.10:…`, daemon.host, or a loopback one such as ::1), else loopback (the
    // default 127.0.0.1 bind, or a wildcard one), and the port really bound (`--port` wins over daemon.port). Never the
    // request's Host: installed through remote access (Tailscale Serve, a tunnel) or the web dev server that names the
    // proxy, and the node posted to 127.0.0.1:80, :443 or :5173; on a single-address bind 127.0.0.1 reached nothing.
    // (There the node is a LAN peer like any process on this box, and sends no key: it gets in with requireApiKey off.)
    const bound = (d.bindHost ?? '').trim().replace(/^\[|\]$/g, '')
    const host = !bound || bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound.includes(':') ? `[${bound}]` : bound
    const base = `http://${host}:${d.bindPort ?? d.store.snapshot().daemon.port}`

    const gateDir = join(customNodes, 'turbollm_gate')
    try {
      mkdirSync(gateDir, { recursive: true })
      writeFileSync(join(gateDir, '__init__.py'), gateNodeSource(base))
    } catch (e) {
      return err(c, 500, 'fs_write_failed', `Could not write the gate node: ${e instanceof Error ? e.message : e}`)
    }
    d.store.update((x) => {
      x.comfyui.gatePath = gateDir
    })
    return c.json({ ok: true, path: gateDir, base, note: 'Restart ComfyUI to activate the gate.' })
  })

  // Remove the installed gate node and forget its path.
  app.post('/api/v1/comfyui/uninstall', (c) => {
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'api_key_required', 'Removing the ComfyUI gate node requires a valid API key.')
    const dir = d.store.snapshot().comfyui.gatePath
    if (dir && existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (e) {
        return err(c, 500, 'fs_write_failed', `Could not remove the gate node: ${e instanceof Error ? e.message : e}`)
      }
    }
    d.store.update((x) => {
      x.comfyui.gatePath = ''
    })
    return c.json({ ok: true })
  })

  // ---- daemon self-restart (spec 08 §2) ----
  // Re-execs the whole daemon so port / LAN-bind changes take effect. Schedule on a
  // short timeout so this 202 flushes before the listen socket is torn down; the UI
  // then shows a "Restarting…" overlay and polls /status until the new process is up.
  app.post('/api/v1/daemon/restart', (c) => {
    if (!d.requestRestart) {
      return err(c, 501, 'not_supported', 'Daemon restart is not available in this run mode.')
    }
    const restart = d.requestRestart
    setTimeout(() => restart(), 200).unref()
    return c.json({ ok: true, restarting: true }, 202)
  })

  // Writes the chat database to disk now and answers once it is there. Android's sql.js keeps it in
  // memory and writes it soon after changes (sql-js-database.ts); the app calls this before its Quit
  // kills the process, and before its service stops, so a reply that finished a moment before is not
  // lost. Same gate as /daemon/restart. node:sqlite (desktop) writes every change itself: nothing to do.
  app.post('/api/v1/daemon/flush', (c) => {
    // A running reply's text first: it reaches its row only every 10 s while it streams (runGeneration's partial
    // saves), and the Android app ends the process right after this answers.
    d.chatTurns.saveRunningReplies()
    const onDisk = d.db.flush()
    if (onDisk === null) return c.json({ ok: true, flushed: false })
    if (!onDisk) return err(c, 500, 'flush_failed', 'The chat database could not be written to disk.')
    return c.json({ ok: true })
  })
}
