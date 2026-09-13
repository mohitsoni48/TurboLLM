import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTailscaleStatus,
  TailscaleServeProvider,
  TailscaleFunnelProvider,
  reconcileTailscale,
  type RunTailscale,
} from './tailscale'

const RUNNING = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.' } })
const STOPPED = JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } })

/** A served-config fixture in the REAL shape `tailscale serve status --json` /
 *  `tailscale funnel status --json` emit — verified against Tailscale's own CLI/ipn source
 *  (tailscale/tailscale @ main, read 2026-09-13; see tailscale.ts's module comment on
 *  `reconcileTailscale` for the citation), not guessed. */
function servedConfig(opts: { hostPort: string; proxy: string; funnel?: boolean }): string {
  return JSON.stringify({
    Web: { [opts.hostPort]: { Handlers: { '/': { Proxy: opts.proxy } } } },
    ...(opts.funnel ? { AllowFunnel: { [opts.hostPort]: true } } : {}),
  })
}

test('tailscale: parses a running tailnet and strips the trailing dot from DNSName', () => {
  const s = parseTailscaleStatus(RUNNING)
  assert.equal(s.running, true)
  assert.equal(s.dnsName, 'box.tail1234.ts.net')
})

test('tailscale: a logged-out backend is not running', () => {
  assert.equal(parseTailscaleStatus(STOPPED).running, false)
})

test('tailscale: junk output parses as not-running rather than throwing', () => {
  assert.equal(parseTailscaleStatus('not json at all').running, false)
})

test('tailscale: both providers declare a system-state lifecycle', () => {
  const run: RunTailscale = async () => ({ code: 0, stdout: RUNNING, stderr: '' })
  assert.equal(new TailscaleServeProvider({ port: 443 }, run).lifecycle, 'system-state')
  assert.equal(new TailscaleFunnelProvider({ port: 443 }, run).lifecycle, 'system-state')
})

test('tailscale: preflight reports unavailable when the CLI is missing', async () => {
  const run: RunTailscale = async () => {
    throw new Error('spawn tailscale ENOENT')
  }
  const s = await new TailscaleServeProvider({ port: 443 }, run).preflight()
  assert.equal(s.kind, 'unavailable')
  assert.equal(s.kind === 'unavailable' && s.reason.includes('not installed'), true)
})

test('tailscale: preflight reports needs-setup when installed but logged out', async () => {
  const run: RunTailscale = async () => ({ code: 0, stdout: STOPPED, stderr: '' })
  const s = await new TailscaleServeProvider({ port: 443 }, run).preflight()
  assert.equal(s.kind, 'needs-setup')
  assert.equal(s.kind === 'needs-setup' && s.reason.includes('tailscale up'), true)
})

test('tailscale: preflight is ready on a logged-in tailnet', async () => {
  const run: RunTailscale = async () => ({ code: 0, stdout: RUNNING, stderr: '' })
  assert.equal((await new TailscaleServeProvider({ port: 443 }, run).preflight()).kind, 'off')
})

test('tailscale: serve argv forwards the PUBLIC port to the LOCAL ingress port', async () => {
  const calls: string[][] = []
  const run: RunTailscale = async (args) => {
    calls.push(args)
    return { code: 0, stdout: RUNNING, stderr: '' }
  }
  const p = new TailscaleServeProvider({ port: 8443 }, run)
  const { url } = await p.start(6997)
  assert.deepEqual(calls[calls.length - 1], ['serve', '--bg', '--https=8443', 'http://127.0.0.1:6997'])
  assert.equal(url, 'https://box.tail1234.ts.net:8443')
})

test('tailscale: funnel argv uses funnel, not serve', async () => {
  const calls: string[][] = []
  const run: RunTailscale = async (args) => {
    calls.push(args)
    return { code: 0, stdout: RUNNING, stderr: '' }
  }
  await new TailscaleFunnelProvider({ port: 443 }, run).start(6997)
  assert.deepEqual(calls[calls.length - 1], ['funnel', '--bg', '--https=443', 'http://127.0.0.1:6997'])
})

test('tailscale: a 443 URL omits the port; a non-default port keeps it', async () => {
  const run: RunTailscale = async () => ({ code: 0, stdout: RUNNING, stderr: '' })
  assert.equal((await new TailscaleServeProvider({ port: 443 }, run).start(6997)).url, 'https://box.tail1234.ts.net')
})

test('tailscale: stop RESETS the system state, it does not just drop a handle', async () => {
  const calls: string[][] = []
  const run: RunTailscale = async (args) => {
    calls.push(args)
    return { code: 0, stdout: RUNNING, stderr: '' }
  }
  const p = new TailscaleFunnelProvider({ port: 443 }, run)
  await p.start(6997)
  await p.stop()
  assert.deepEqual(calls[calls.length - 1], ['funnel', '--https=443', 'off'])
})

// --- ADR-422 Phase 3 final review, Important finding I3 -----------------------------------
// `RunTailscale`'s `code` used to be a dead field: nothing branched on it, so a genuine CLI
// failure (a permission refusal, a rejected Funnel grant) silently reported success.

test('tailscale: start() THROWS on a non-zero exit code, carrying stderr, instead of reporting a fabricated connect', async () => {
  const run: RunTailscale = async (args) => {
    if (args[0] === 'status') return { code: 0, stdout: RUNNING, stderr: '' }
    return { code: 1, stdout: '', stderr: 'tailscale: Funnel is not enabled for this tailnet' }
  }
  const p = new TailscaleFunnelProvider({ port: 443 }, run)
  await assert.rejects(() => p.start(6997), /Funnel is not enabled for this tailnet/)
})

test('tailscale: start() still throws on a non-zero exit code even with empty stderr', async () => {
  const run: RunTailscale = async (args) => {
    if (args[0] === 'status') return { code: 0, stdout: RUNNING, stderr: '' }
    return { code: 1, stdout: '', stderr: '' }
  }
  const p = new TailscaleServeProvider({ port: 443 }, run)
  await assert.rejects(() => p.start(6997), /non-zero status/)
})

test('tailscale: a successful start() never throws', async () => {
  const run: RunTailscale = async () => ({ code: 0, stdout: RUNNING, stderr: '' })
  await assert.doesNotReject(() => new TailscaleServeProvider({ port: 443 }, run).start(6997))
})

test('tailscale: stop() does NOT throw even when the underlying off command fails (exit code)', async () => {
  const run: RunTailscale = async () => ({ code: 1, stdout: '', stderr: 'permission denied' })
  const p = new TailscaleFunnelProvider({ port: 443 }, run)
  await assert.doesNotReject(() => p.stop())
})

test('tailscale: stop() does NOT throw even when run() itself rejects (tailscale gone entirely)', async () => {
  const run: RunTailscale = async () => {
    throw new Error('spawn tailscale ENOENT')
  }
  const p = new TailscaleFunnelProvider({ port: 443 }, run)
  await assert.doesNotReject(() => p.stop())
})

// --- ADR-422 Phase 3 final review, Important finding I1 -----------------------------------
// reconcileTailscale is now keyed off OBSERVED `tailscale serve status --json` output rather
// than desired config, and takes `ingressPort` directly.

test('reconcile: our ingress port is observed served (serve, no funnel) → serve off is issued', async () => {
  const calls: string[][] = []
  const run: RunTailscale = async (args) => {
    calls.push(args)
    if (args[0] === 'serve' && args[1] === 'status') {
      return {
        code: 0,
        stdout: servedConfig({ hostPort: 'box.ts.net:443', proxy: 'http://127.0.0.1:6997' }),
        stderr: '',
      }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const acted = await reconcileTailscale(6997, run)
  assert.equal(acted, true)
  assert.deepEqual(calls[0], ['serve', 'status', '--json'])
  assert.deepEqual(calls[calls.length - 1], ['serve', '--https=443', 'off'])
})

test('reconcile: our ingress port is observed FUNNELED → funnel off is issued (not serve)', async () => {
  const calls: string[][] = []
  const run: RunTailscale = async (args) => {
    calls.push(args)
    if (args[0] === 'serve' && args[1] === 'status') {
      return {
        code: 0,
        stdout: servedConfig({ hostPort: 'box.ts.net:8443', proxy: 'http://127.0.0.1:6997', funnel: true }),
        stderr: '',
      }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const acted = await reconcileTailscale(6997, run)
  assert.equal(acted, true)
  assert.deepEqual(calls[calls.length - 1], ['funnel', '--https=8443', 'off'])
})

test('reconcile: an unrelated tailscale serve (different target) is never touched — the false-positive direction', async () => {
  const calls: string[][] = []
  const run: RunTailscale = async (args) => {
    calls.push(args)
    return {
      code: 0,
      stdout: servedConfig({ hostPort: 'box.ts.net:443', proxy: 'https://internal.example.com' }),
      stderr: '',
    }
  }
  assert.equal(await reconcileTailscale(6997, run), false)
  assert.equal(calls.length, 1, 'only the status check should run — no off command for a target that is not ours')
})

test('reconcile: our port served on a DIFFERENT public port is still found and reset', async () => {
  const run: RunTailscale = async (args) => {
    if (args[0] === 'serve' && args[1] === 'status') {
      return {
        code: 0,
        stdout: servedConfig({ hostPort: 'box.ts.net:10000', proxy: 'http://127.0.0.1:6996' }),
        stderr: '',
      }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  assert.equal(await reconcileTailscale(6996, run), true)
})

test('reconcile: nothing served → no action, no off command', async () => {
  const calls: string[][] = []
  const run: RunTailscale = async (args) => {
    calls.push(args)
    return { code: 0, stdout: JSON.stringify({}), stderr: '' }
  }
  assert.equal(await reconcileTailscale(6997, run), false)
  assert.equal(calls.length, 1)
})

test('reconcile: Tailscale not installed (ENOENT) → false, never throws', async () => {
  const run: RunTailscale = async () => {
    throw new Error('spawn tailscale ENOENT')
  }
  await assert.doesNotReject(async () => {
    assert.equal(await reconcileTailscale(6997, run), false)
  })
})

test('reconcile: the status command itself failing (non-zero code) → false, no guessing', async () => {
  const calls: string[][] = []
  const run: RunTailscale = async (args) => {
    calls.push(args)
    return { code: 1, stdout: '', stderr: 'tailscaled not running' }
  }
  assert.equal(await reconcileTailscale(6997, run), false)
  assert.equal(calls.length, 1, 'a failed status read must never fall through to issuing an off command')
})

test('reconcile: the observed target is ours but the off command itself fails (non-zero exit) → returns false', async () => {
  const run: RunTailscale = async (args) => {
    if (args[0] === 'serve' && args[1] === 'status') {
      return {
        code: 0,
        stdout: servedConfig({ hostPort: 'box.ts.net:443', proxy: 'http://127.0.0.1:6997' }),
        stderr: '',
      }
    }
    return { code: 1, stdout: '', stderr: 'permission denied' }
  }
  assert.equal(await reconcileTailscale(6997, run), false)
})

test('reconcile: junk/unparseable status output → false, never throws', async () => {
  const run: RunTailscale = async () => ({ code: 0, stdout: 'not json at all', stderr: '' })
  assert.equal(await reconcileTailscale(6997, run), false)
})
