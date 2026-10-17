// applyEngineUpdate keeps the active engine as it was, on every branch that re-registers the updated engine: the
// scheduler auto-updates every engine set to `auto`, active or not, and an update that made the updated engine active
// switched the user's engine overnight (an inactive CPU fallback replaced the CUDA engine; an inactive LiteRT-LM was
// sent every GGUF). update-apply.test.ts covers the llama.cpp branch and KoboldCpp's inactive case; this table covers
// the rest — TurboQuant, KoboldCpp, llamafile and the five pip kinds — both ways: an engine that was not active stays
// inactive, and one that was stays active.
// No network and no Python: GitHub is a stubbed fetch, uv and the venv interpreters are shell scripts (POSIX only), and
// the MLX family, which installs only on macOS, runs with process.platform faked to darwin.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { tmpDir } from '../test-support/tmp'
import { koboldcppAssetName, koboldcppBinPath } from './koboldcpp'
import { llamafileBinPath } from './llamafile'
import { Registry } from './registry'
import { applyEngineUpdate, type UpdateApplyDeps } from './update-apply'

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

interface UpdateCase {
  label: string
  skip: string | false
  /** Fake process.platform as darwin for the update (the MLX family installs only on macOS). */
  darwin?: boolean
  /** Stage the installed engine's files (and stub what the update fetches); returns the engine as registered. */
  install: (t: Ctx, root: string) => Pick<Engine, 'kind' | 'binPath' | 'version'>
  /** The version the engine reports once updated, proving the update ran. */
  updatedVersion: string
}

const posix = process.platform === 'win32' && 'shell-script engine binaries'
const pip = (kind: 'mlx' | 'mlx-vlm' | 'vllm' | 'litert-lm', label: string, versionPrefix: string): UpdateCase => ({
  label,
  skip: posix,
  darwin: kind === 'mlx' || kind === 'mlx-vlm',
  install: (_t, root) => ({ kind, binPath: stageVenv(root, kind), version: `${versionPrefix} 1.0.0` }),
  updatedVersion: `${versionPrefix} 9.9.9`,
})

const KOBOLD_ASSETS = ['koboldcpp.exe', 'koboldcpp-nocuda.exe', 'koboldcpp-linux-x64', 'koboldcpp-linux-x64-nocuda', 'koboldcpp-mac-arm64']
  .map((name) => ({ name, browser_download_url: `https://dl.test/${name}` }))

const CASES: UpdateCase[] = [
  {
    label: 'TurboQuant',
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
    skip: (posix || (!koboldcppAssetName(false) && !koboldcppAssetName(true))) && 'no KoboldCpp asset for this OS / POSIX only',
    install: (t, root) => {
      writeExe(koboldcppBinPath(root), 'kobold v1')
      stubFetch(t, (url) => (url.includes('api.github.com') ? new Response(JSON.stringify({ tag_name: 'v2.0.0', assets: KOBOLD_ASSETS })) : new Response('kobold v2')))
      return { kind: 'koboldcpp', binPath: koboldcppBinPath(root), version: 'v1.0.0' }
    },
    updatedVersion: 'v2.0.0',
  },
  {
    label: 'llamafile',
    skip: !['win32', 'darwin', 'linux'].includes(process.platform) && "outside llamafile's catalog platforms",
    install: (t, root) => {
      writeExe(llamafileBinPath(root), 'llamafile 0.10.2')
      stubFetch(t, (url) =>
        url.includes('api.github.com')
          ? new Response(JSON.stringify({ tag_name: '0.10.3', assets: [{ name: 'llamafile-0.10.3', browser_download_url: 'https://dl.test/llamafile' }] }))
          : new Response('llamafile 0.10.3'),
      )
      return { kind: 'llamafile', binPath: llamafileBinPath(root), version: '0.10.2' }
    },
    updatedVersion: '0.10.3',
  },
  pip('mlx', 'MLX', 'mlx-lm'),
  {
    label: 'Rapid-MLX',
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
  pip('vllm', 'vLLM', 'vllm'),
  pip('litert-lm', 'LiteRT-LM', 'litert-lm'),
]

/** A daemon whose active engine is an unrelated CUDA build (or, with `updatedIsActive`, the engine being updated). */
function setup(t: Ctx, c: UpdateCase, updatedIsActive: boolean): { d: UpdateApplyDeps; updated: Engine } {
  const store = ConfigStore.load(join(tmpDir('tllm-update-activation-'), 'config.json'))
  const root = join(store.dir(), 'engines')
  const installed = c.install(t, root)
  const cuda: Engine = { id: 'cuda', name: 'cuda', kind: 'llama-server', binPath: '/opt/cuda/llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-01-01T00:00:00Z' }
  const updated: Engine = { id: 'updated', name: c.label, capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-01-01T00:00:00Z', updatePolicy: 'auto', ...installed }
  store.update((cfg) => {
    cfg.engines.push(cuda, updated)
    cfg.activeEngineId = updatedIsActive ? 'updated' : 'cuda'
  })
  const d = {
    store,
    registry: new Registry(store),
    manager: { status: () => ({ state: 'stopped' }), currentOpts: () => null, stopAndWait: async () => {} },
    provision: { start() {}, progress() {}, done() {}, fail() {} },
  } as unknown as UpdateApplyDeps
  return { d, updated }
}

async function update(c: UpdateCase, d: UpdateApplyDeps, engine: Engine): Promise<void> {
  const actualPlatform = process.platform
  if (c.darwin) Object.defineProperty(process, 'platform', { value: 'darwin' })
  try {
    await applyEngineUpdate(d, engine)
  } finally {
    Object.defineProperty(process, 'platform', { value: actualPlatform })
  }
}

for (const c of CASES) {
  test(`${c.label} update: an engine that was not active stays inactive, and one that was stays active`, { skip: c.skip }, async (t) => {
    {
      const { d, updated } = setup(t, c, false)
      await update(c, d, updated)
      const after = d.registry.list().engines.find((e) => e.binPath === updated.binPath)
      assert.equal(after?.version, c.updatedVersion, 'the update ran')
      assert.equal(d.registry.active()?.id, 'cuda', 'updating an inactive engine must not switch the active one')
    }
    {
      const { d, updated } = setup(t, c, true)
      await update(c, d, updated)
      const after = d.registry.list().engines.find((e) => e.binPath === updated.binPath)
      assert.equal(after?.version, c.updatedVersion, 'the update ran')
      assert.equal(d.registry.active()?.binPath, updated.binPath, 'an engine that was active stays active')
    }
  })
}
