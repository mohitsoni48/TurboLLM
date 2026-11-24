import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpDir } from '../test-support/tmp'
import { SandboxManager } from './sandbox-manager'
import { SandboxError, type SandboxProcess, type SandboxProcessOptions, type SandboxRunResult } from './sandbox-process'

/** A stand-in process: runs resolve when the test says so. */
class FakeProc {
  alive = true
  busy = true
  runs: string[] = []
  pending: Array<(r: SandboxRunResult) => void> = []
  private exits: Array<() => void> = []
  killed = 0
  constructor(readonly opts: SandboxProcessOptions) {}
  async start() { this.busy = false }
  run(code: string): Promise<SandboxRunResult> {
    if (!this.alive) return Promise.reject(new SandboxError('busy', 'dead'))
    this.busy = true
    this.runs.push(code)
    return new Promise((resolve, reject) => {
      this.pending.push((r) => { this.busy = false; resolve(r) })
      this.exits.push(() => reject(new SandboxError('crashed', 'killed')))
    })
  }
  finish() { this.pending.shift()?.({ ok: true, stdout: 'done', stderr: '', files: [], skipped: [] }) }
  onExit(fn: () => void) { this.exits.push(fn) }
  kill() {
    if (!this.alive) return
    this.killed++
    this.alive = false
    for (const fn of this.exits) fn()
  }
  async whenExited() {}
}

const setup = (installed = true, idleMs?: number) => {
  const dir = tmpDir('tllm-sandbox-mgr-')
  const procs: FakeProc[] = []
  const m = new SandboxManager({
    runtime: { dir: () => dir, denoPath: () => 'deno', pyodideDir: () => dir, view: () => ({ supported: true, installed: installed ? { deno: '2.9.6', pyodide: '0.29.5' } : null, downloadBytes: 0, diskBytes: 0, job: { state: 'idle', doneBytes: 0 } }) },
    idleMs,
    createProcess: (o) => { const p = new FakeProc(o); procs.push(p); return p as unknown as SandboxProcess },
  })
  return { m, procs }
}

const tick = () => new Promise((r) => setImmediate(r))

test('manager: a chat keeps its warm sandbox between runs', async () => {
  const { m, procs } = setup()
  const a = m.run('c1', 'x = 1', [])
  await tick(); procs[0].finish(); await a
  const b = m.run('c1', 'print(x)', [])
  await tick(); procs[0].finish(); await b
  assert.equal(procs.length, 1)
  assert.deepEqual(procs[0].runs, ['x = 1', 'print(x)'])
  assert.equal(m.has('c1'), true)
})

test('manager: another chat never gets this chat\'s sandbox: an idle one is closed first', async () => {
  const { m, procs } = setup()
  const a = m.run('c1', 'secret = 1', [])
  await tick(); procs[0].finish(); await a
  const b = m.run('c2', 'print(secret)', [])
  await tick(); procs[1].finish(); await b
  assert.equal(procs.length, 2)
  assert.equal(procs[0].alive, false)
  assert.deepEqual(procs[1].runs, ['print(secret)'])
  assert.equal(m.has('c1'), false)
})

test('manager: a run in another chat is refused while one is running', async () => {
  const { m, procs } = setup()
  const a = m.run('c1', 'slow()', [])
  await tick()
  await assert.rejects(m.run('c2', 'x', []), (e: unknown) => e instanceof SandboxError && e.code === 'busy')
  procs[0].finish(); await a
})

test('manager: Stop kills the run\'s process', async () => {
  const { m, procs } = setup()
  const ac = new AbortController()
  const a = m.run('c1', 'loop()', [], ac.signal)
  await tick()
  ac.abort()
  await assert.rejects(a, SandboxError)
  assert.equal(procs[0].alive, false)
  assert.equal(m.has('c1'), false)
})

test('manager: an idle sandbox closes after the idle time', async () => {
  const { m, procs } = setup(true, 50)
  const a = m.run('c1', 'x', [])
  await tick(); procs[0].finish(); await a
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(procs[0].alive, false)
  assert.equal(m.has('c1'), false)
})

test('manager: nothing starts without an installed runtime; closeAll ends what runs', async () => {
  const off = setup(false)
  await assert.rejects(off.m.run('c1', 'x', []), (e: unknown) => e instanceof SandboxError && e.code === 'start_failed')
  assert.equal(off.procs.length, 0)
  const { m, procs } = setup()
  const a = m.run('c1', 'x', [])
  await tick()
  await m.closeAll()
  await assert.rejects(a, SandboxError)
  assert.equal(procs[0].alive, false)
})
