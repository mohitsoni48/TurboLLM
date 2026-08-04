// Tests for the claude_cli MCP bridge: writeClaudeMcpConfig, and launchCli's use of it. A
// claude_cli Code session is the real external Claude Code CLI, never routed through
// ToolRegistry — without this, it has no way to know TurboLLM's routine/agent tools even exist
// (observed live: asked to "create a routine", it improvised an OS-level cron job instead). See
// mcp-server.ts's own module header for the full story.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { launchCli, writeClaudeMcpConfig, type ConfigFs } from './cli-launch.js'

const HOME = '/home/tester'

/** In-memory ConfigFs — mirrors cli-launch.config.test.ts's own memFs helper exactly (same
 *  shape, same reasoning: neither the real filesystem nor a real process is ever touched). */
function memFs(seed: Record<string, string> = {}): ConfigFs & { files: Map<string, string>; mkdirs: string[] } {
  const files = new Map<string, string>(Object.entries(seed))
  const mkdirs: string[] = []
  return {
    files,
    mkdirs,
    home: HOME,
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)!
    },
    writeFile: async (p: string, data: string) => { files.set(p, data) },
    mkdir: async (p: string) => { mkdirs.push(p) },
  }
}

interface CapturedSpawn { cmd: string; args: string[] }
function makeSpawn(): { calls: CapturedSpawn[]; fn: Parameters<typeof launchCli>[3] } {
  const calls: CapturedSpawn[] = []
  const fn: Parameters<typeof launchCli>[3] = (cmd, args) => {
    calls.push({ cmd, args })
    const ee = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>
    setImmediate(() => ee.emit('exit', 0, null))
    return ee
  }
  return { calls, fn }
}

function silenceOutput(): () => void {
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith('▸')) return true
    return (outW as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  return () => { process.stdout.write = outW; process.stderr.write = errW }
}

function makeFetch(): typeof fetch {
  const fn = async (input: string | URL | globalThis.Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/api/v1/status')) {
      return { ok: true, status: 200, json: async () => ({ engine: { state: 'running' }, model: { key: 'm', name: 'm' } }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }
  return fn as unknown as typeof fetch
}

// ── writeClaudeMcpConfig ─────────────────────────────────────────────────────

test('writeClaudeMcpConfig: writes a turbollm mcpServers entry pointing at the given port', async () => {
  const fs = memFs()
  const path = await writeClaudeMcpConfig(6996, fs)
  assert.equal(path, join(HOME, '.turbollm', 'mcp-launch-config.json'))
  assert.deepEqual(fs.mkdirs, [join(HOME, '.turbollm')])
  const written = JSON.parse(fs.files.get(path)!)
  assert.deepEqual(written, { mcpServers: { turbollm: { command: 'npx', args: ['turbollm', 'mcp-server', '--port', '6996'] } } })
})

test('writeClaudeMcpConfig: a different port produces a different args array', async () => {
  const fs = memFs()
  const path = await writeClaudeMcpConfig(9000, fs)
  const written = JSON.parse(fs.files.get(path)!)
  assert.deepEqual(written.mcpServers.turbollm.args, ['turbollm', 'mcp-server', '--port', '9000'])
})

test('writeClaudeMcpConfig: overwrites a stale config from a previous launch rather than merging', async () => {
  const path = join(HOME, '.turbollm', 'mcp-launch-config.json')
  const fs = memFs({ [path]: JSON.stringify({ mcpServers: { turbollm: { command: 'npx', args: ['turbollm', 'mcp-server', '--port', '1111'] } } }) })
  await writeClaudeMcpConfig(6996, fs)
  const written = JSON.parse(fs.files.get(path)!)
  assert.deepEqual(written.mcpServers.turbollm.args, ['turbollm', 'mcp-server', '--port', '6996'])
})

// ── launchCli's use of it ────────────────────────────────────────────────────

test('launchCli: a claude launch appends --mcp-config pointing at the written config', async () => {
  const { calls, fn } = makeSpawn()
  const fs = memFs()
  const unsilence = silenceOutput()
  try {
    const code = await launchCli('claude', 6996, [], fn, undefined, makeFetch(), undefined, fs)
    assert.equal(code, 0)
    assert.equal(calls.length, 1)
    const args = calls[0].args
    const flagIndex = args.indexOf('--mcp-config')
    assert.ok(flagIndex !== -1, `expected --mcp-config in args: ${JSON.stringify(args)}`)
    assert.equal(args[flagIndex + 1], join(HOME, '.turbollm', 'mcp-launch-config.json'))
    assert.ok(fs.files.has(args[flagIndex + 1]), 'the file the flag points at must actually have been written')
  } finally {
    unsilence()
  }
})

test('launchCli: --mcp-config is appended AFTER whatever passthrough flags the terminal launch already built', async () => {
  const { calls, fn } = makeSpawn()
  const fs = memFs()
  const unsilence = silenceOutput()
  try {
    await launchCli('claude', 6996, ['--permission-mode', 'plan'], fn, undefined, makeFetch(), undefined, fs)
    const args = calls[0].args
    assert.deepEqual(args.slice(0, 2), ['--permission-mode', 'plan'])
    assert.deepEqual(args.slice(2), ['--mcp-config', join(HOME, '.turbollm', 'mcp-launch-config.json')])
  } finally {
    unsilence()
  }
})

test('launchCli: a filesystem failure writing the MCP config degrades gracefully — the launch still happens, without the flag', async () => {
  const { calls, fn } = makeSpawn()
  const brokenFs: ConfigFs = {
    home: HOME,
    readFile: async () => { throw new Error('ENOENT') },
    writeFile: async () => { throw new Error('EACCES: permission denied') },
    mkdir: async () => {},
  }
  const unsilence = silenceOutput()
  try {
    const code = await launchCli('claude', 6996, [], fn, undefined, makeFetch(), undefined, brokenFs)
    assert.equal(code, 0, 'the launch itself must still succeed')
    assert.equal(calls.length, 1)
    assert.ok(!calls[0].args.includes('--mcp-config'), 'no flag pointing at a file that was never actually written')
  } finally {
    unsilence()
  }
})
