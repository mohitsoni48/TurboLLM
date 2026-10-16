// The ?update=1 install routes keep the active engine as it was: an update made the updated engine the active one,
// which switched engines under a model loaded on another (for LiteRT-LM it sent every GGUF to it). An install still
// activates the engine. routes.litert-lm.test.ts and routes.backend-update.test.ts cover LiteRT-LM, the llama.cpp
// backends and llamafile; every other route has its own copy of the rule, so this table covers each of them: vLLM,
// SGLang, TurboQuant, KoboldCpp, and MLX, Rapid-MLX and MLX-VLM (with process.platform faked to darwin, as those
// routes refuse every other OS). Each case checks an update of an inactive engine, an update of the active one, and an
// install. No network and no Python: GitHub is a stubbed fetch, uv and the venv interpreters are shell scripts, so
// POSIX only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, type Engine } from '../config/config'
import { koboldcppAssetName, koboldcppBinPath } from '../engines/koboldcpp'
import { Registry } from '../engines/registry'
import type { Deps } from '../deps'
import { registerApi } from './routes'
import { tmpDir } from '../test-support/tmp'

type Ctx = { after: (fn: () => void) => void }

const realFetch = globalThis.fetch
function stubFetch(t: Ctx, handle: (url: string) => Response): void {
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (url: string | URL | Request) => handle(url instanceof Request ? url.url : String(url))) as typeof fetch
}

function writeExe(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

/** A fake uv (every command succeeds) and a venv interpreter that reports Python 3.12 and, for any `-c` probe, 9.9.9. */
function stageVenv(root: string, kind: string): string {
  writeExe(join(root, 'uv', 'uv'), '#!/bin/sh\nexit 0\n')
  const python = join(root, kind, 'venv', 'bin', 'python')
  writeExe(python, '#!/bin/sh\nif [ "$1" = --version ]; then echo "Python 3.12.4"; else echo 9.9.9; fi\n')
  return python
}

interface RouteCase {
  label: string
  /** POST /api/v1/engines/<route> */
  route: string
  skip: string | false
  /** Fake process.platform as darwin (the MLX-family routes refuse every other OS). */
  darwin?: boolean
  /** Stage the installed engine's files (and stub what the update fetches); returns the engine as registered. */
  install: (t: Ctx, root: string) => Pick<Engine, 'kind' | 'binPath' | 'version'>
  /** The version the engine reports once updated, proving the update ran. */
  updatedVersion: string
}

const posix = process.platform === 'win32' && 'shell-script engine binaries'
const pip = (kind: 'mlx' | 'mlx-vlm' | 'vllm' | 'sglang', label: string, versionPrefix: string): RouteCase => ({
  label,
  route: kind,
  skip: posix,
  darwin: kind === 'mlx' || kind === 'mlx-vlm',
  install: (_t, root) => ({ kind, binPath: stageVenv(root, kind), version: `${versionPrefix} 1.0.0` }),
  updatedVersion: `${versionPrefix} 9.9.9`,
})

const KOBOLD_ASSETS = ['koboldcpp.exe', 'koboldcpp-nocuda.exe', 'koboldcpp-linux-x64', 'koboldcpp-linux-x64-nocuda', 'koboldcpp-mac-arm64']
  .map((name) => ({ name, browser_download_url: `https://dl.test/${name}` }))

const CASES: RouteCase[] = [
  pip('vllm', 'vLLM', 'vllm'),
  pip('sglang', 'SGLang', 'sglang'),
  {
    label: 'TurboQuant',
    route: 'turboquant',
    skip: process.platform === 'win32' && 'TurboQuant has no Windows prebuilt; shell-script binaries',
    install: (t, root) => {
      const bin = join(root, 'turboquant', 'llama-server')
      writeExe(bin, '#!/bin/sh\necho "version: 100 (old1234)"\n')
      const src = tmpDir('tllm-tq-src-')
      writeExe(join(src, 'llama-server'), '#!/bin/sh\necho "version: 200 (abcdef1)"\n')
      const archive = join(tmpDir('tllm-tq-'), 'tq.tar.gz')
      execFileSync('tar', ['-czf', archive, '-C', src, 'llama-server'])
      const osTag = process.platform === 'darwin' ? 'macos' : 'linux'
      const asset = `llama-b200-bin-${osTag}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`
      stubFetch(t, (url) =>
        url.includes('api.github.com')
          ? new Response(JSON.stringify([{ tag_name: `b200-${osTag}`, assets: [{ name: asset, browser_download_url: `https://cdn.test/${asset}` }] }]))
          : new Response(readFileSync(archive)),
      )
      return { kind: 'llama-server', binPath: bin, version: '100 (old1234)' }
    },
    updatedVersion: '200 (abcdef1)',
  },
  {
    label: 'KoboldCpp',
    route: 'koboldcpp',
    skip: (posix || (!koboldcppAssetName(false) && !koboldcppAssetName(true))) && 'no KoboldCpp asset for this OS / POSIX only',
    install: (t, root) => {
      writeExe(koboldcppBinPath(root), 'kobold v1')
      stubFetch(t, (url) => (url.includes('api.github.com') ? new Response(JSON.stringify({ tag_name: 'v2.0.0', assets: KOBOLD_ASSETS })) : new Response('kobold v2')))
      return { kind: 'koboldcpp', binPath: koboldcppBinPath(root), version: 'v1.0.0' }
    },
    updatedVersion: 'v2.0.0',
  },
  pip('mlx', 'MLX', 'mlx-lm'),
  {
    label: 'Rapid-MLX',
    route: 'rapid-mlx',
    skip: posix,
    darwin: true,
    install: (_t, root) => {
      stageVenv(root, 'rapid-mlx')
      const bin = join(root, 'rapid-mlx', 'venv', 'bin', 'rapid-mlx')
      writeExe(bin, '#!/bin/sh\necho "rapid-mlx 9.9.9"\n')
      return { kind: 'rapid-mlx', binPath: bin, version: 'rapid-mlx 1.0.0' }
    },
    updatedVersion: 'rapid-mlx 9.9.9',
  },
  pip('mlx-vlm', 'MLX-VLM', 'mlx-vlm'),
]

/** The route over a registry holding an unrelated CUDA build (active) and the installed engine `c` stages. `run`
 *  returns once the provision settled: null when it finished, else the failure message. */
function harness(t: Ctx, c: RouteCase) {
  const store = ConfigStore.load(join(tmpDir('tllm-route-update-activation-'), 'config.json'))
  const root = join(store.dir(), 'engines')
  const installed = c.install(t, root)
  const cuda: Engine = { id: 'cuda', name: 'cuda', kind: 'llama-server', binPath: '/opt/cuda/llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-01-01T00:00:00Z' }
  const updated: Engine = { id: 'updated', name: c.label, capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-01-01T00:00:00Z', ...installed }
  store.update((cfg) => {
    cfg.engines.push(cuda, updated)
    cfg.activeEngineId = 'cuda'
  })
  const registry = new Registry(store)
  let settle: (failure: string | null) => void = () => {}
  const d = {
    version: 'test',
    store,
    registry,
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null, stopAndWait: async () => {}, logPath: () => '' },
    provision: { get: () => ({ active: false }), start() {}, progress() {}, done: () => settle(null), fail: (m: string) => settle(m) },
    build: { isActive: () => false },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  const run = async (query: string): Promise<string | null> => {
    const actualPlatform = process.platform
    if (c.darwin) Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const finished = new Promise<string | null>((r) => { settle = r })
      const res = await app.request(`/api/v1/engines/${c.route}${query}`, { method: 'POST' })
      assert.equal(res.status, 202, await res.clone().text())
      return await finished
    } finally {
      Object.defineProperty(process, 'platform', { value: actualPlatform })
    }
  }
  const engine = () => registry.list().engines.find((e) => e.binPath === updated.binPath)
  return { registry, run, engine }
}

for (const c of CASES) {
  test(`POST /engines/${c.route}?update=1 keeps the active engine unless the updated one was it; an install activates`, { skip: c.skip }, async (t) => {
    const h = harness(t, c)
    assert.equal(await h.run('?update=1'), null)
    assert.equal(h.engine()?.version, c.updatedVersion, 'the update ran')
    assert.equal(h.registry.active()?.id, 'cuda', 'updating an inactive engine must not switch the active one')

    h.registry.activate(h.engine()!.id)
    assert.equal(await h.run('?update=1'), null)
    assert.equal(h.registry.active()?.binPath, h.engine()?.binPath, 'an engine that was active stays active')

    h.registry.activate('cuda')
    h.registry.remove(h.engine()!.id) // Disabled: Install registers it again
    assert.equal(await h.run(''), null)
    assert.ok(h.engine(), 'the install registered it')
    assert.equal(h.registry.active()?.binPath, h.engine()?.binPath, 'an install activates the engine')
  })
}
