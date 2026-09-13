import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTailscaleStatus,
  TailscaleServeProvider,
  TailscaleFunnelProvider,
  reconcileTailscale,
} from './tailscale'

const RUNNING = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.' } })
const STOPPED = JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } })

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
  const run = async () => ({ code: 0, stdout: RUNNING })
  assert.equal(new TailscaleServeProvider({ port: 443 }, run).lifecycle, 'system-state')
  assert.equal(new TailscaleFunnelProvider({ port: 443 }, run).lifecycle, 'system-state')
})

test('tailscale: preflight reports unavailable when the CLI is missing', async () => {
  const run = async () => {
    throw new Error('spawn tailscale ENOENT')
  }
  const s = await new TailscaleServeProvider({ port: 443 }, run).preflight()
  assert.equal(s.kind, 'unavailable')
  assert.equal(s.kind === 'unavailable' && s.reason.includes('not installed'), true)
})

test('tailscale: preflight reports needs-setup when installed but logged out', async () => {
  const run = async () => ({ code: 0, stdout: STOPPED })
  const s = await new TailscaleServeProvider({ port: 443 }, run).preflight()
  assert.equal(s.kind, 'needs-setup')
  assert.equal(s.kind === 'needs-setup' && s.reason.includes('tailscale up'), true)
})

test('tailscale: preflight is ready on a logged-in tailnet', async () => {
  const run = async () => ({ code: 0, stdout: RUNNING })
  assert.equal((await new TailscaleServeProvider({ port: 443 }, run).preflight()).kind, 'off')
})

test('tailscale: serve argv forwards the PUBLIC port to the LOCAL ingress port', async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    return { code: 0, stdout: RUNNING }
  }
  const p = new TailscaleServeProvider({ port: 8443 }, run)
  const { url } = await p.start(6997)
  assert.deepEqual(calls[calls.length - 1], ['serve', '--bg', '--https=8443', 'http://127.0.0.1:6997'])
  assert.equal(url, 'https://box.tail1234.ts.net:8443')
})

test('tailscale: funnel argv uses funnel, not serve', async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    return { code: 0, stdout: RUNNING }
  }
  await new TailscaleFunnelProvider({ port: 443 }, run).start(6997)
  assert.deepEqual(calls[calls.length - 1], ['funnel', '--bg', '--https=443', 'http://127.0.0.1:6997'])
})

test('tailscale: a 443 URL omits the port; a non-default port keeps it', async () => {
  const run = async () => ({ code: 0, stdout: RUNNING })
  assert.equal((await new TailscaleServeProvider({ port: 443 }, run).start(6997)).url, 'https://box.tail1234.ts.net')
})

test('tailscale: stop RESETS the system state, it does not just drop a handle', async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    return { code: 0, stdout: RUNNING }
  }
  const p = new TailscaleFunnelProvider({ port: 443 }, run)
  await p.start(6997)
  await p.stop()
  assert.deepEqual(calls[calls.length - 1], ['funnel', '--https=443', 'off'])
})

test('reconcile: config off but the port still served → an off command is issued', async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    return {
      code: 0,
      stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.ts.net.' } }),
    }
  }
  const acted = await reconcileTailscale({ enabled: false, provider: 'tailscale-funnel', port: 443 }, run)
  assert.equal(acted, true)
  assert.deepEqual(calls[calls.length - 1], ['funnel', '--https=443', 'off'])
})

test('reconcile: config on → nothing is touched', async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    return { code: 0, stdout: RUNNING }
  }
  assert.equal(await reconcileTailscale({ enabled: true, provider: 'tailscale-funnel', port: 443 }, run), false)
  assert.equal(calls.length, 0)
})

test('reconcile: a non-Tailscale provider is never touched', async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    return { code: 0, stdout: RUNNING }
  }
  assert.equal(await reconcileTailscale({ enabled: false, provider: 'cloudflare-quick', port: 443 }, run), false)
  assert.equal(calls.length, 0)
})
