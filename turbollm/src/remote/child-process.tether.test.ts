// A remote-access provider (cloudflared, ngrok) and the tailscale CLI end with the daemon (util/tether.ts). A
// SIGKILLed daemon left the provider running, parented to init, keeping a PUBLIC URL alive to a port that may be
// serving something else, and a `tailscale` call hung on a wedged tailscaled ran on past its 10 s timeout, which
// is a daemon timer. Stand-ins record their pids in files and never write to stdio after the daemon died.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ChildTunnel, killTrackedTunnelsSync, reapStaleTunnels } from './child-process'
import { RemoteAccessManager } from './manager'
import { CloudflareQuickProvider } from './providers/cloudflare-quick'
import { TailscaleFunnelProvider, TailscaleServeProvider } from './providers/tailscale'
import { killTetheredSync, stopTethered } from '../util/tether'
import { isGone, killRecorded, pidWrittenTo, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'POSIX process groups' : false

/** A stand-in cloudflared: starts a `sleep` grandchild, writes its pid to `pidFile`, prints a trycloudflare URL
 *  once, and exits at once on SIGTERM. */
function providerScript(dir: string, pidFile: string): string {
  const file = join(dir, 'provider.cjs')
  writeFileSync(file, `
const { spawn } = require('child_process')
const g = spawn('sleep', ['300'], { stdio: 'ignore' })
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))
process.stderr.write('INF |  https://stand-in-tunnel.trycloudflare.com  |\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1e9)
`)
  return file
}

test('a daemon SIGKILLed with a tunnel up takes the provider and its grandchild with it', { skip }, async () => {
  const dir = tmpDir('tllm-tunnel-tether-')
  const grandchildFile = join(dir, 'grandchild.pid')
  const provider = providerScript(dir, grandchildFile)
  const d = await startStandInDaemon(`
import { ChildTunnel } from ${srcUrl('remote/child-process.ts')}
const t = new ChildTunnel(${JSON.stringify(join(dir, 'data'))})
const url = await t.spawnAndWait(process.execPath, [${JSON.stringify(provider)}], /https:\\/\\/\\S+\\.trycloudflare\\.com/, 10_000)
report({ url })
setInterval(() => {}, 1e9)
`)
  try {
    const { url } = await d.next<{ url: string }>()
    const [name] = readdirSync(join(dir, 'data', 'run'))
    const providerPid = Number(/\d+/.exec(name)![0])
    const grandchild = await pidWrittenTo(grandchildFile)
    record(providerPid, grandchild)
    assert.equal(url, 'https://stand-in-tunnel.trycloudflare.com')
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([providerPid, grandchild], 1000), [], 'the provider and its grandchild are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

test('ChildTunnel.stop(): the provider exits on its SIGTERM, and what it started goes with its group', { skip }, async () => {
  const dir = tmpDir('tllm-tunnel-stop-')
  const grandchildFile = join(dir, 'grandchild.pid')
  const t = new ChildTunnel(join(dir, 'data'))
  try {
    await t.spawnAndWait(process.execPath, [providerScript(dir, grandchildFile)], /https:\/\/\S+\.trycloudflare\.com/, 10_000)
    const [name] = readdirSync(join(dir, 'data', 'run'))
    const rec = JSON.parse(readFileSync(join(dir, 'data', 'run', name), 'utf8')) as { pid: number; group?: boolean }
    const grandchild = await pidWrittenTo(grandchildFile)
    record(rec.pid, grandchild)
    assert.equal(rec.group, true, 'the pidfile says the provider leads its own group')
    await t.stop()
    assert.deepEqual(await waitGone([rec.pid, grandchild], 1000), [])
  } finally {
    await t.stop()
    killRecorded()
  }
})

test('reapStaleTunnels kills an orphaned provider\'s whole group when its pidfile says it leads one', { skip }, async () => {
  const dir = tmpDir('tllm-tunnel-reap-')
  const pidFile = join(dir, 'worker.pid')
  const orphan = spawn('sh', ['-c', `sleep 300 & echo $! > ${pidFile}; wait`], { detached: true, stdio: 'ignore' })
  record(orphan.pid)
  try {
    const worker = await pidWrittenTo(pidFile)
    record(worker)
    mkdirSync(join(dir, 'run'), { recursive: true })
    writeFileSync(join(dir, 'run', `tunnel-${orphan.pid}.pid`), JSON.stringify({ pid: orphan.pid, owner: 0, startedAt: Date.now() - 300, group: true }))

    assert.equal(reapStaleTunnels(dir), 1)
    assert.deepEqual(await waitGone([orphan.pid!, worker], 1000), [], 'the provider and what it started')
  } finally {
    killRecorded()
  }
})

test('killTrackedTunnelsSync (the exit handler) kills the provider\'s whole group, from its pidfile', { skip }, async () => {
  const dir = tmpDir('tllm-tunnel-exitkill-')
  const grandchildFile = join(dir, 'grandchild.pid')
  const data = join(dir, 'data')
  const t = new ChildTunnel(data)
  try {
    await t.spawnAndWait(process.execPath, [providerScript(dir, grandchildFile)], /https:\/\/\S+\.trycloudflare\.com/, 10_000)
    const [name] = readdirSync(join(data, 'run'))
    const rec = JSON.parse(readFileSync(join(data, 'run', name), 'utf8')) as { pid: number; group?: boolean }
    const grandchild = await pidWrittenTo(grandchildFile)
    record(rec.pid, grandchild)
    assert.equal(rec.group, true)
    killTrackedTunnelsSync(data)
    // Checked without yielding, as in the 'exit' handler: no event-loop turn means the daemon never sees the
    // provider exit, so its lifeline stays open and the watcher plays no part. The group kill alone must do it.
    const pause = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 1000
    while (!(isGone(rec.pid) && isGone(grandchild)) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 20)
    assert.deepEqual([rec.pid, grandchild].filter((p) => !isGone(p)), [], 'the provider and what it started')
    assert.deepEqual(readdirSync(join(data, 'run')), [], 'and its pidfile is cleared')
  } finally {
    await t.stop()
    killRecorded()
  }
})

test('a daemon SIGKILLed mid-call takes a hanging `tailscale` with it', { skip }, async () => {
  const dir = tmpDir('tllm-tailscale-tether-')
  const pidFile = join(dir, 'tailscale.pid')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 300\n`)
  chmodSync(join(bin, 'tailscale'), 0o755)
  const d = await startStandInDaemon(`
import { runTailscale } from ${srcUrl('remote/providers/tailscale.ts')}
report({ started: true })
await runTailscale(['status', '--json'])
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  try {
    await d.next()
    const pid = await pidWrittenTo(pidFile)
    record(pid)
    assert.equal(isGone(pid), false, 'the call hangs')
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([pid], 1000), [], 'gone within 1 s, not at its 10 s timeout or never')
  } finally {
    killRecorded(d.pid)
  }
})

test('a graceful stop still turns Tailscale Serve and Funnel off: stopTethered beside remote.disable() leaves the `off` to it', { skip }, async () => {
  // Both teardowns in cli.ts run `Promise.all([..., remote.disable(), stopTethered(), ...])`. remote.disable()
  // starts the `off` synchronously, so it is a live tethered entry by the time stopTethered looks. It runs to its
  // end because the CLI's kind is 'tunnel', which stopTethered leaves to its owner; under any other kind it would be
  // SIGTERMed before it ran, and tailscaled would keep the serve (or the public Funnel) pointed at the ingress port.
  const dir = tmpDir('tllm-tailscale-off-')
  const log = join(dir, 'calls.log')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  // A real CLI takes a few ms to start and reach tailscaled over its socket.
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh
echo "start $*" >> ${JSON.stringify(log)}
case "$1" in status) echo '{"BackendState":"Running","Self":{"DNSName":"box.tail1234.ts.net."}}';; esac
sleep 0.05
echo "done $*" >> ${JSON.stringify(log)}
`)
  chmodSync(join(bin, 'tailscale'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`
  try {
    for (const [subcommand, Provider] of [['serve', TailscaleServeProvider], ['funnel', TailscaleFunnelProvider]] as const) {
      const remote = new RemoteAccessManager({ app: new Hono(), ingressPort: 0, makeProvider: () => new Provider({ port: 443 }), probe: async () => true })
      await remote.enable()
      assert.equal(remote.state().kind, 'connected')
      writeFileSync(log, '')
      await Promise.all([remote.disable(), stopTethered()])
      assert.equal(remote.state().kind, 'off')
      assert.match(readFileSync(log, 'utf8'), new RegExp(`^done ${subcommand} --https=443 off$`, 'm'), `${subcommand}: the \`off\` ran to its end`)
    }
  } finally {
    process.env.PATH = path
  }
})

test('a graceful stop that comes while a remote Stop is turning Tailscale Serve or Funnel off waits for that `off`', { skip }, async () => {
  // A remote-access Stop, a provider switch, the flag turned off or a restart's teardown runs remote.disable(); a
  // signal's shutdown then runs its own. That second one finds the provider taken and ends at once, so the shutdown
  // used to settle, the 'exit' handler's killTetheredSync (every kind) killed the first one's `off` mid-call, and
  // tailscaled kept the serve, or the PUBLIC Funnel, pointed at the ingress port after TurboLLM was gone.
  // remote.disableAll() also waits for that earlier `off`.
  const dir = tmpDir('tllm-tailscale-off-during-stop-')
  const log = join(dir, 'calls.log')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  // A tailscaled slow to answer: the shutdown comes 30 ms into the Stop's `off`.
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh
echo "start $*" >> ${JSON.stringify(log)}
case "$1" in status) echo '{"BackendState":"Running","Self":{"DNSName":"box.tail1234.ts.net."}}';; *) sleep 0.3;; esac
echo "done $*" >> ${JSON.stringify(log)}
`)
  chmodSync(join(bin, 'tailscale'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`
  try {
    for (const [subcommand, Provider] of [['serve', TailscaleServeProvider], ['funnel', TailscaleFunnelProvider]] as const) {
      const remote = new RemoteAccessManager({ app: new Hono(), ingressPort: 0, makeProvider: () => new Provider({ port: 443 }), probe: async () => true })
      await remote.enable()
      assert.equal(remote.state().kind, 'connected')
      writeFileSync(log, '')
      void remote.disable() // the remote Stop
      await new Promise((r) => setTimeout(r, 30))
      await Promise.all([remote.disableAll(), stopTethered()]) // the shutdown's teardown
      killTetheredSync() // its 'exit' handler
      assert.equal(remote.state().kind, 'off')
      await new Promise((r) => setTimeout(r, 500)) // a killed `off` would have written its line by now
      assert.match(readFileSync(log, 'utf8'), new RegExp(`^done ${subcommand} --https=443 off$`, 'm'), `${subcommand}: the \`off\` ran to its end`)
    }
  } finally {
    process.env.PATH = path
  }
})

test('a graceful stop that comes while a remote Stop is stopping cloudflared lets it exit on its SIGTERM', { skip }, async () => {
  // The same shape for a child provider (cloudflared, ngrok): the Stop's SIGTERM is under way, the shutdown's own
  // disable() finds the provider taken, and the 'exit' handler's group SIGKILL cut its own exit short.
  const dir = tmpDir('tllm-tunnel-stop-during-stop-')
  const data = join(dir, 'data')
  const log = join(dir, 'provider.log')
  mkdirSync(join(data, 'cloudflared'), { recursive: true })
  const bin = join(data, 'cloudflared', 'cloudflared') // where ensureCloudflared finds an installed one
  writeFileSync(bin, `#!/bin/sh
trap 'sleep 0.3; echo "exited on its SIGTERM" >> ${JSON.stringify(log)}; exit 0' TERM
echo 'INF |  https://stand-in-tunnel.trycloudflare.com  |' >&2
while :; do sleep 1 & wait $!; done
`)
  chmodSync(bin, 0o755)
  const remote = new RemoteAccessManager({ app: new Hono(), ingressPort: 0, makeProvider: () => new CloudflareQuickProvider(data), probe: async () => true })
  try {
    await remote.enable()
    assert.equal(remote.state().kind, 'connected')
    const [name] = readdirSync(join(data, 'run'))
    record(Number(/\d+/.exec(name)![0]))
    void remote.disable() // the remote Stop
    await new Promise((r) => setTimeout(r, 30))
    await Promise.all([remote.disableAll(), stopTethered()]) // the shutdown's teardown
    killTetheredSync() // its 'exit' handler
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', 'exited on its SIGTERM\n')
  } finally {
    await remote.disable()
    killRecorded()
  }
})
