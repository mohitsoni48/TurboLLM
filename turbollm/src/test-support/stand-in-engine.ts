// A real ConfigStore, Manager and ModelRouter driving a stand-in llama-server, for the routine tests that need the
// engine's own load and stop behaviour: with keep-N 1 a routine's model loads into the primary, so Manager.load stops
// the user's model before the routine's own starts (or fails to). The stand-in is a node script behind a POSIX shell
// wrapper, so a test using it skips on Windows.
import { chmodSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Manager } from '../engines/manager'
import { ModelRouter } from '../gateway/model-router'
import { ConfigStore, type Engine } from '../config/config'
import { ComfyGuard } from '../engines/comfy-guard'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'
import { tmpDir } from './tmp'

/** A stand-in llama-server: exits at once for a model whose path names `broken`, else answers /health on --port after
 *  200 ms, and exits at once on SIGTERM. */
const FAKE_ENGINE_JS = `
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
if (args[args.indexOf('-m') + 1].includes('broken')) { console.error('error loading model'); process.exit(1) }
setTimeout(() => {
  http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
}, 200)
process.on('SIGTERM', () => process.exit(0))
`

function ggufEntry(dir: string, name: string): ModelEntry {
  return {
    key: `${name}|Q4_K_M|1`, name, path: join(dir, `${name}.gguf`), dir, format: 'gguf', sizeBytes: 1,
    sizeLabel: '1 B', arch: 'llama', quant: 'Q4_K_M', nativeCtx: 4096, blockCount: 1, headCountKv: 1, headDim: 1,
    moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0,
    hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
  } as unknown as ModelEntry
}

/** A port nothing listens on now, from the OS's ephemeral range: a model pinned to it stays clear of the 8081+ walk.
 *  Every test whose stand-in engine binds the port it is handed pins one: allocPort only probes a port and closes it
 *  again, so two test files walking 8081+ at once could be handed the same port, and the engine that bound it second
 *  died with EADDRINUSE. Pin it with StartOpts.preferredPort, or with a saved profile's `port` when a ModelRouter
 *  builds the StartOpts (as realEngineSetUp does). */
export async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as AddressInfo
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return port
}

/** Three models on the stand-in: `userModel` and `routineModel`, which start, and `brokenModel`, whose engine exits at
 *  once. Every engine this starts is stopped when the test ends.
 *  `comfy`: a real ComfyGuard, wired as cli.ts wires it, with its reverse gate on: `comfyFree.hook`, when set, runs
 *  once inside the next `POST /free` call. */
export async function realEngineSetUp(t: { after: (fn: () => unknown) => void }, opts: { comfy?: boolean } = {}) {
  const dir = tmpDir('tllm-stand-in-engine-')
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  const engine: Engine = { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' }
  const userModel = ggufEntry(dir, 'user-model')
  const brokenModel = ggufEntry(dir, 'broken-model')
  const routineModel = ggufEntry(dir, 'routine-model')
  const models = [userModel, brokenModel, routineModel]
  const ports = await Promise.all(models.map(() => freePort()))
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => {
    c.gateway.autoSwap = false // a routine's swap does not depend on it (loadExplicit)
    c.gateway.keepN = 1
    models.forEach((m, i) => { c.modelProfiles[m.key] = { fake: { profile: { port: ports[i] }, updatedAt: '' } } })
    c.comfyui.enabled = opts.comfy ?? false
    c.comfyui.reverseGate = true
    c.comfyui.url = 'http://comfyui.invalid'
  })
  const manager = new Manager(store)
  const comfyFree: { hook: (() => Promise<void>) | null } = { hook: null }
  const guard = opts.comfy
    ? new ComfyGuard(store, manager, 30, async (url) => {
      const hook = url.endsWith('/free') ? comfyFree.hook : null
      comfyFree.hook = null
      await hook?.()
      return { ok: true, status: 200 }
    })
    : undefined
  const registry = { active: () => engine, layaEngine: () => undefined, litertLmEngine: () => undefined } as unknown as Registry
  const scanner = {
    list: () => ({ models, scanning: false, lastScanAt: '' }),
    get: (key: string) => models.find((m) => m.key === key),
  } as unknown as Scanner
  const modelRouter = new ModelRouter(store, registry, manager, scanner, guard)
  if (guard) {
    guard.setPoolStopper(async () => {
      await Promise.all([...modelRouter.poolEngineIds()].map((id) => modelRouter.stopPoolSlotsOnEngine(id, { force: true })))
    })
    guard.setSwapLock((fn) => modelRouter.withSwapLock(fn))
  }
  t.after(async () => {
    guard?.stop()
    await manager.stopAndWait({ force: true })
  })
  return { store, manager, modelRouter, guard, comfyFree, userModel, brokenModel, routineModel }
}
