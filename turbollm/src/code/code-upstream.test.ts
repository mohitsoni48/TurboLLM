// Code against a Turbo Link host (ADR-376) — where a Code turn is generated.
//
// Code shipped hard-wired to `d.manager.target()`, so the properties that matter most here
// are the NEGATIVE ones: with the local engine stopped, a remote turn must still resolve,
// and it must never present the link token as the host's bearer credential. Every remote
// case below therefore runs with NO local engine at all — if one of them starts passing
// only when a model is loaded locally, Code has gone secretly local again.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCodeUpstream } from './code-upstream.js'
import type { Deps } from '../deps.js'

const REMOTE = {
  linkId: 'lnk1',
  baseUrl: 'https://rig.trycloudflare.com',
  token: 'tllm-hostsecret',
  modelKey: 'qwen3-35b',
}

/** `localRunning: false` is the configuration Turbo Link exists to serve — a machine with no
 *  GPU of its own driving one that has it. */
function mkDeps(opts: { localRunning?: boolean; route?: unknown } = {}): Deps {
  return {
    manager: {
      status: () => (opts.localRunning
        ? { state: 'running', model: { key: 'local-model', name: 'Local Model', ctx: 16384 } }
        : { state: 'stopped', model: null }),
      target: () => (opts.localRunning ? 'http://127.0.0.1:8080' : ''),
      currentOpts: () => ({ modelPath: '/models/local.gguf' }),
    },
    registry: { active: () => ({ kind: 'llama-server' }) },
    modelRouter: { resolveRemoteTarget: () => opts.route },
    remoteCatalog: { modelOn: () => ({ key: REMOTE.modelKey, name: 'Qwen3 35B', nativeCtx: 131072 }) },
  } as unknown as Deps
}

test('a remote id resolves with the local engine stopped', () => {
  const d = mkDeps({ localRunning: false, route: { target: REMOTE.baseUrl, remote: REMOTE } })
  const up = resolveCodeUpstream(d, 'rig/qwen3-35b')

  assert.equal(up.remote?.linkId, 'lnk1')
  // The host's UNQUALIFIED key: a `<machine>/` prefix names no machine over there and would
  // fall back to whatever it happens to have loaded.
  assert.equal(up.modelId, REMOTE.modelKey)
  assert.equal(up.modelName, 'Qwen3 35B')
  assert.equal(up.contextWindow, 131072)
  assert.equal(up.provider.baseUrl, `${REMOTE.baseUrl}/v1`)
  // Nothing may build a local engine URL for a turn running elsewhere.
  assert.equal(up.target, '')
})

test('the link token travels as X-TurboLLM-Auth, never as the host bearer', () => {
  const d = mkDeps({ localRunning: false, route: { target: REMOTE.baseUrl, remote: REMOTE } })
  const up = resolveCodeUpstream(d, 'rig/qwen3-35b')

  assert.equal(up.provider.headers?.['X-TurboLLM-Auth'], REMOTE.token)
  // `Authorization` on the host is its own API-key credential — a different secret with
  // different scope. pi adds it only when authHeader is on, so this flag is the whole guard.
  assert.equal(up.provider.authHeader, false)
})

test('an offline link fails by name and never degrades to the local model', () => {
  const d = mkDeps({
    localRunning: true,
    route: { status: 503, message: "'rig' is not connected (unreachable). Reconnect it in Settings → Turbo Link." },
  })
  assert.throws(
    () => resolveCodeUpstream(d, 'rig/qwen3-35b'),
    // Not 'model_not_loaded' — the local model IS loaded here, and silently running an
    // agentic turn on it instead is worse than refusing.
    /rig.*not connected/,
  )
})

test('no requested model is the unchanged local path', () => {
  const d = mkDeps({ localRunning: true })
  const up = resolveCodeUpstream(d)

  assert.equal(up.remote, undefined)
  assert.equal(up.provider.baseUrl, 'http://127.0.0.1:8080/v1')
  assert.equal(up.provider.apiKey, 'agent-key')
  assert.equal(up.provider.authHeader, true)
  assert.equal(up.contextWindow, 16384)
})

test('no requested model and no local engine still throws model_not_loaded', () => {
  assert.throws(() => resolveCodeUpstream(mkDeps({ localRunning: false })), /model_not_loaded/)
})

test('a local key containing a slash is NOT treated as remote', () => {
  // The router returns undefined for an id naming no linked machine — which is exactly how
  // `unsloth/Qwen3-GGUF` keeps loading locally instead of 503ing forever.
  const d = mkDeps({ localRunning: true, route: undefined })
  const up = resolveCodeUpstream(d, 'unsloth/Qwen3-GGUF')

  assert.equal(up.remote, undefined)
  assert.equal(up.provider.baseUrl, 'http://127.0.0.1:8080/v1')
})
