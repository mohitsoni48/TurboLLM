// launchCli('claude') writes the MCP config `claude --mcp-config` reads (writeClaudeMcpConfig)
// through its `_mcpFs` argument, and left out that is the real file system under the home folder:
// cli-launch.test.ts, cli-launch.remote.test.ts and cli-launch.model.test.ts left it out in most of
// their claude launches, and each run wrote ~/.turbollm/mcp-launch-config.json (for port 6996) on
// the developer's machine and on CI's runner. Every claude launch in the tests now passes an
// in-memory fs; this pins that such a launch then writes nothing under the home folder at all.
//
// HOME (USERPROFILE on Windows) points at a temp folder BEFORE cli-launch.js is loaded: its real fs
// reads the home folder once, when the module loads. Nothing here imports it statically.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from './test-support/tmp'
import type { ConfigFs } from './cli-launch.js'

const home = tmpDir('tllm-launch-home-')
process.env.HOME = home
process.env.USERPROFILE = home
const { launchCli } = await import('./cli-launch.js')

const spawn: Parameters<typeof launchCli>[3] = () => {
  const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
  setImmediate(() => ee.emit('exit', 0, null))
  return ee
}

/** A daemon with a chat model already running, so the launch goes all the way to the spawn. */
const daemonFetch = (async (input: string | URL | globalThis.Request) => {
  const url = String(input)
  if (url.includes('/api/v1/status')) {
    return { ok: true, status: 200, json: async () => ({ engine: { state: 'running' }, model: { key: 'qwen3-8b', name: 'Qwen3 8B' } }) } as Response
  }
  if (url.includes('/api/v1/models')) {
    return { ok: true, status: 200, json: async () => ({ models: [{ key: 'qwen3-8b', name: 'Qwen3 8B' }] }) } as Response
  }
  return { ok: false, status: 404, json: async () => ({}) } as Response
}) as unknown as typeof fetch

/** launchCli's own stdout lines all start with '▸'; anything else is node:test's channel. */
async function quiet(fn: () => Promise<number>): Promise<number> {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith('▸')) return true
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    return await fn()
  } finally {
    process.stdout.write = outW
    process.stderr.write = errW
  }
}

test('a claude launch given an in-memory fs writes nothing under the home folder', async () => {
  const files = new Map<string, string>()
  const fs: ConfigFs = {
    home: '/home/tester',
    readFile: async (p) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)!
    },
    writeFile: async (p, data) => { files.set(p, data) },
    mkdir: async () => {},
  }

  const code = await quiet(() => launchCli('claude', 6996, [], spawn, undefined, daemonFetch, undefined, fs))

  assert.equal(code, 0)
  assert.ok(files.has(join('/home/tester', '.turbollm', 'mcp-launch-config.json')), 'the MCP config went to the fs it was given')
  assert.deepEqual(readdirSync(home), [], 'nothing was written under the home folder')
})

// Runs after the one above, which needs the folder empty. Without this, that test would also pass
// if the home folder had not been redirected here at all.
test('the same launch with no fs writes its MCP config under the home folder, which is why every test passes one', async () => {
  const code = await quiet(() => launchCli('claude', 6996, [], spawn, undefined, daemonFetch))

  assert.equal(code, 0)
  assert.ok(existsSync(join(home, '.turbollm', 'mcp-launch-config.json')))
})
