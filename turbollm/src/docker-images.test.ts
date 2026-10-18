// The distribution images (Dockerfile.nvidia, Dockerfile.amd at the repo root) boot the daemon
// once during `docker build` to seed an engine, then run it on 0.0.0.0 in every container. Which
// of those two runs mints the bootstrap API key is decided by the flags the Dockerfile passes, so
// this reads them from the Dockerfiles and gives them to the real ConfigStore and
// provisionBootstrapApiKey.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ConfigStore } from './config/config'
import { isLoopbackBindHost, provisionBootstrapApiKey } from './auth'
import type { Deps } from './deps'
import { parseListenAddr } from './net'
import { tmpDir } from './test-support/tmp'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const IMAGES = ['Dockerfile.nvidia', 'Dockerfile.amd']

interface Image {
  /** The config.json the image seeds (`RUN echo '{…}' > /root/.turbollm/config.json`). */
  seeded: string
  /** The build-time daemon run's arguments (`RUN (node bin/turbollm.mjs … &)`). */
  buildArgs: string[]
  /** The container's arguments (CMD). */
  cmd: string[]
}

function readImage(name: string): Image {
  const text = readFileSync(join(REPO_ROOT, name), 'utf8').replace(/\r\n/g, '\n').replace(/\\\n/g, ' ')
  const seeded = /^RUN echo '([^']*)' > \/root\/\.turbollm\/config\.json$/m.exec(text)
  assert.ok(seeded, `${name} must seed /root/.turbollm/config.json with RUN echo '…'`)
  const build = /^RUN \(node bin\/turbollm\.mjs ([^&]*)&\)/m.exec(text)
  assert.ok(build, `${name} must boot the daemon during the build as RUN (node bin/turbollm.mjs … &)`)
  const cmd = /^CMD (\[.*\])$/m.exec(text)
  assert.ok(cmd, `${name} must have a CMD [...]`)
  return { seeded: seeded[1], buildArgs: build[1].trim().split(/\s+/), cmd: JSON.parse(cmd[1]) as string[] }
}

/** The host a daemon started with `args` binds. Only the choice of address is copied from cli.ts's
 *  "Resolve listen address" (--port wins over --addr and takes the host lanBind, or daemon.host,
 *  asks for); the host is read from it by cli.ts's own parser, parseListenAddr. A copy of the split
 *  cli.ts once used (everything before the last colon) read a portless `--addr 127.0.0.1` as
 *  `127.0.0.`, not loopback, and `[::1]:6996` as `[::1]`, where cli.ts binds 127.0.0.1 and ::1. */
function boundHost(args: string[], store: ConfigStore): string {
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : '')
  const { daemon } = store.snapshot()
  const defaultHost = daemon.lanBind ? '0.0.0.0' : (daemon.host || '127.0.0.1')
  const addr = flag('--port') ? `${defaultHost}:${flag('--port')}` : flag('--addr') || `${defaultHost}:${daemon.port}`
  return parseListenAddr(addr).host
}

test('boundHost reads --addr as cli.ts binds it: a portless host and a bracketed IPv6 one too', () => {
  const store = ConfigStore.load(join(tmpDir('turbollm-docker-image-'), 'config.json'))
  store.update((c) => { c.daemon.lanBind = true })
  assert.deepEqual(
    ['127.0.0.1:6996', '127.0.0.1', 'localhost', '[::1]:6996', '::1', '0.0.0.0', '[::]:6996'].map((a) => boundHost(['--addr', a], store)),
    ['127.0.0.1', '127.0.0.1', 'localhost', '::1', '::1', '0.0.0.0', '::'],
  )
  assert.equal(boundHost(['--port', '6997', '--addr', '127.0.0.1:6996'], store), '0.0.0.0', '--port takes lanBind\'s host')
})

// The image seeds lanBind true, so the build run's `--port 6996` bound 0.0.0.0: that daemon minted
// the bootstrap key, printed it in the build log and stored it in the image's config.json, where
// every container built from the image accepted it.
for (const name of IMAGES) {
  test(`${name}: the build mints no API key; the container's first start mints one into its volume and prints it`, () => {
    const image = readImage(name)
    const path = join(tmpDir('turbollm-docker-image-'), 'config.json')
    writeFileSync(path, image.seeded)
    const store = ConfigStore.load(path)
    const d = { store } as unknown as Deps
    assert.equal(store.snapshot().daemon.lanBind, true, 'the image seeds lanBind on (its own comment says why)')
    assert.equal(store.snapshot().daemon.requireApiKey, true)

    const buildHost = boundHost(image.buildArgs, store)
    assert.ok(isLoopbackBindHost(buildHost), `the build-time daemon binds loopback, not ${buildHost}`)
    assert.equal(provisionBootstrapApiKey(d, buildHost), null, 'no key is minted into the image')
    assert.deepEqual(ConfigStore.load(path).snapshot().apiKeys, [])

    // The first container start, on the config the image left in ~/.turbollm (the volume).
    assert.ok(image.cmd.includes('--print-token'), 'the container prints its key on every start')
    const firstKey = provisionBootstrapApiKey(d, boundHost(image.cmd, store))
    assert.match(firstKey ?? '', /^tllm-/, 'the container mints its own key at first start')
    assert.equal(ConfigStore.load(path).snapshot().apiKeys.length, 1)
  })
}
