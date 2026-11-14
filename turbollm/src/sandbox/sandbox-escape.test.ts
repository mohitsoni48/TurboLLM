// The escape suite (GitHub #52): the real host under the real Deno, started exactly as the daemon starts it
// (SandboxProcess, denoArgs, denoEnv), attacked from Python through the JS escape every Pyodide has. Each attack must
// be blocked, and nothing may reach a listener standing in for the daemon.
//
// Skipped unless TURBOLLM_SANDBOX_ESCAPE_RUNTIMES names a folder: the runtime (77 MB) is installed there with the
// pinned hashes, or reused when it already is. CI runs it as its own job (ci.yml, sandbox-escape), on changes to the
// sandbox and nightly, with that folder cached. Every Deno or Pyodide upgrade must pass it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { SandboxRuntime } from './runtime-install'
import { SandboxError, SandboxProcess } from './sandbox-process'

const RUNTIMES = process.env.TURBOLLM_SANDBOX_ESCAPE_RUNTIMES
const skip = RUNTIMES ? false : 'set TURBOLLM_SANDBOX_ESCAPE_RUNTIMES to run the escape suite'

let rt: SandboxRuntime
let proc: SandboxProcess
let server: Server
let port = 0
let hits = 0
const victim = tmpDir('tllm-sandbox-victim-')
const secret = join(victim, 'config.json')
const planted = join(victim, 'should-not-exist.txt')

const start = async (runTimeoutMs = 30_000) => {
  const denoDir = join(rt.dir(), 'deno-dir')
  mkdirSync(denoDir, { recursive: true })
  const p = new SandboxProcess({ denoPath: rt.denoPath(), pyodideDir: rt.pyodideDir(), cwd: rt.dir(), denoDir, runTimeoutMs })
  await p.start()
  return p
}

/** Runs `js` (a function body returning a string or a promise of one) from Python through the escape. */
const viaEscape = async (p: SandboxProcess, js: string): Promise<string> => {
  const r = await p.run(`
from pyodide.ffi import to_js
F = to_js({}).constructor.constructor
print(await F("return Promise.resolve().then(() => (function () {" + ${JSON.stringify(js)} + "})())")())
`)
  return r.ok ? r.stdout.trim() : `blocked (Python error): ${r.error?.split('\n').pop()}`
}

test.before(async () => {
  if (!RUNTIMES) return
  rt = new SandboxRuntime({ runtimesDir: () => RUNTIMES, announce: () => {} })
  await rt.install()
  writeFileSync(secret, '{"apiKeys":"secret"}')
  server = createServer((_req, res) => { hits++; res.writeHead(201); res.end('{}') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as { port: number }).port
  proc = await start()
})

test.after(() => {
  proc?.kill()
  server?.close()
})

const win = process.platform === 'win32'
const ATTACKS: Record<string, () => string> = {
  'network: node:http POST to the daemon port': () => `return import('node:http').then(h => new Promise(res => {
      const r = h.request({host:'127.0.0.1', port:${port}, method:'POST', path:'/api/v1/mcp/servers'}, x => res('REACHED HTTP ' + x.statusCode))
      r.on('error', e => res('blocked: ' + (e.code || e.name)))
      r.end('{}')
    })).catch(e => 'blocked: ' + e.name)`,
  'network: raw TCP with node:net': () => `return import('node:net').then(n => new Promise(res => {
      try { const s = n.connect(${port}, '127.0.0.1', () => res('REACHED tcp')); s.on('error', e => res('blocked: ' + (e.code || e.name))) }
      catch (e) { res('blocked: ' + e.name) }
    }))`,
  'network: fetch': () => `return fetch('http://127.0.0.1:${port}/x').then(r => 'REACHED ' + r.status).catch(e => 'blocked: ' + e.name)`,
  'network: Deno.connect': () => `return Deno.connect({hostname:'127.0.0.1', port:${port}}).then(() => 'REACHED').catch(e => 'blocked: ' + e.name)`,
  'read the daemon\'s config': () => `try { return 'READ ' + Deno.readTextFileSync(${JSON.stringify(secret)}).length } catch (e) { return 'blocked: ' + e.name }`,
  'read a system file with node:fs': () => `return import('node:fs').then(f => { try { return 'READ ' + f.readFileSync(${JSON.stringify(win ? 'C:/Windows/win.ini' : '/etc/hosts')}, 'utf8').length } catch (e) { return 'blocked: ' + (e.code || e.name) } })`,
  'write a file': () => `try { Deno.writeTextFileSync(${JSON.stringify(planted)}, 'x'); return 'WROTE' } catch (e) { return 'blocked: ' + e.name }`,
  'start a program: Deno.Command': () => `try { new Deno.Command('whoami').outputSync(); return 'RAN' } catch (e) { return 'blocked: ' + e.name }`,
  'start a program: node:child_process': () => `return import('node:child_process').then(c => { try { return 'RAN ' + c.execSync('whoami') } catch (e) { return 'blocked: ' + (e.code || e.name) } })`,
  'read environment variables': () => `try { return 'ENV ' + Object.keys(Deno.env.toObject()).length } catch (e) { return 'blocked: ' + e.name }`,
  'load a native library (FFI)': () => `try { Deno.dlopen(${JSON.stringify(win ? 'kernel32.dll' : process.platform === 'darwin' ? 'libSystem.dylib' : 'libc.so.6')}, {}); return 'FFI OPEN' } catch (e) { return 'blocked: ' + e.name }`,
  'network from a Worker': () => `return new Promise(res => {
      const src = "fetch('http://127.0.0.1:${port}/w').then(r => postMessage('REACHED ' + r.status)).catch(e => postMessage('blocked: ' + e.name))"
      const w = new Worker('data:text/javascript,' + encodeURIComponent(src), {type:'module'})
      w.onmessage = e => { res(e.data); w.terminate() }
      w.onerror = e => { e.preventDefault(); res('blocked: worker error') }
    })`,
}

// Without this, a broken escape (every attack a Python error) would pass the suite.
test('control: the escape runs JS, and reads what the wall does allow', { skip }, async () => {
  const got = await viaEscape(proc, `return 'READ ' + Deno.readTextFileSync(${JSON.stringify(join(rt.pyodideDir(), 'package.json'))}).length`)
  assert.match(got, /^READ \d+$/, got)
})

for (const [name, js] of Object.entries(ATTACKS)) {
  test(`escape: ${name}`, { skip }, async () => {
    const got = await viaEscape(proc, js())
    assert.match(got, /^blocked/, got)
    assert.equal(hits, 0, 'nothing reached the stand-in daemon')
  })
}

test('escape: nothing was written outside the sandbox', { skip }, () => {
  assert.equal(existsSync(planted), false)
})

test('escape: a Worker asking for more permissions than its parent gets nothing', { skip }, async () => {
  const p = await start()
  const got = await viaEscape(p, `return new Promise(res => {
      try {
        const w = new Worker('data:text/javascript,postMessage(1)', { type: 'module', deno: { permissions: { net: true } } })
        w.onmessage = () => res('REACHED worker with net')
        w.onerror = e => { e.preventDefault(); res('blocked: worker error') }
      } catch (e) { res('blocked: ' + e.name) }
    })`).catch((e: unknown) => `blocked: process ended (${e instanceof SandboxError ? e.code : String(e)})`)
  assert.match(got, /^blocked/, got)
  p.kill()
})

test('escape: a forged frame on stdout does not survive: the process is killed', { skip }, async () => {
  const p = await start()
  await viaEscape(p, `const h = new TextEncoder().encode(JSON.stringify({ t: 'result', size: 0, ok: true, stdout: 0, stderr: 0, files: [] }))
      const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, h.length)
      Deno.stdout.writeSync(len); Deno.stdout.writeSync(h); return 'forged'`).catch(() => 'rejected')
  // The host's own result frame follows the forged one with no run waiting for it.
  for (let i = 0; i < 100 && p.alive; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(p.alive, false)
})

test('escape: Python past the 512 MB cap gets a MemoryError and the sandbox keeps working', { skip }, async () => {
  const p = await start()
  const r = await p.run('try:\n    x = bytearray(700 * 1024 * 1024)\n    print("allocated")\nexcept MemoryError:\n    print("MemoryError")')
  assert.match(r.stdout, /MemoryError/)
  assert.equal((await p.run('print(1 + 1)')).stdout.trim(), '2')
  p.kill()
})

test('escape: a loop that never ends is killed at the run limit', { skip }, async () => {
  const p = await start(3000)
  await assert.rejects(p.run('while True: pass'), (e: unknown) => e instanceof SandboxError && e.code === 'timeout')
  assert.equal(p.alive, false)
})
