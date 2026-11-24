// SandboxProcess against a stand-in host on Node (no Deno here): the protocol, the limits and the kills. The real host
// under the real Deno is the escape suite's job (sandbox-escape.test.ts, its own CI job).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { encodeFrame } from './sandbox-frames'
import { checkResult, denoArgs, denoEnv, SandboxError, SandboxProcess } from './sandbox-process'

// A stand-in host: speaks the frame protocol, misbehaving as its mode says.
const FAKE_HOST = `
const mode = process.argv[2]
const frame = (h, payload = Buffer.alloc(0)) => {
  const hb = Buffer.from(JSON.stringify({ ...h, size: payload.length }))
  const len = Buffer.alloc(4); len.writeUInt32BE(hb.length, 0)
  return Buffer.concat([len, hb, payload])
}
if (mode === 'silent') setInterval(() => {}, 1000)
else if (mode === 'fatal') process.stdout.write(frame({ t: 'fatal', error: 'no pyodide here' }), () => process.exit(1))
else if (mode === 'garbage') process.stdout.write('Loading numpy...\\n')
else {
  process.stdout.write(frame({ t: 'ready' }))
  if (mode === 'unsolicited') process.stdout.write(frame({ t: 'result', ok: true, stdout: 0, stderr: 0, files: [] }))
  let buf = Buffer.alloc(0)
  process.stdin.on('data', (c) => {
    buf = Buffer.concat([buf, c])
    for (;;) {
      if (buf.length < 4) return
      const hl = buf.readUInt32BE(0)
      if (buf.length < 4 + hl) return
      const h = JSON.parse(buf.subarray(4, 4 + hl).toString())
      if (buf.length < 4 + hl + h.size) return
      const payload = buf.subarray(4 + hl, 4 + hl + h.size)
      buf = buf.subarray(4 + hl + h.size)
      if (mode === 'hang') continue
      if (mode === 'exit') process.exit(3)
      if (mode === 'badsize') { process.stdout.write(frame({ t: 'result', ok: true, stdout: 5, stderr: 0, files: [] }, Buffer.from('ab'))); continue }
      if (mode === 'badname') { process.stdout.write(frame({ t: 'result', ok: true, stdout: 0, stderr: 0, files: [{ name: '../x.png', size: 1 }] }, Buffer.from('a'))); continue }
      // ok: echo the code to stdout, send each input back as an output with a .txt name
      const out = Buffer.from('ran: ' + h.code)
      const files = h.files.map((f, i) => ({ name: 'echo-' + i + '.txt', size: f.size }))
      process.stdout.write(frame({ t: 'result', ok: !h.code.includes('raise'), error: h.code.includes('raise') ? 'ValueError: boom' : undefined, stdout: out.length, stderr: 0, files, skipped: ['a.exe'] }, Buffer.concat([out, payload])))
    }
  })
}
`
const dir = tmpDir('tllm-sandbox-proc-')
const hostFile = join(dir, 'fake-host.cjs')
writeFileSync(hostFile, FAKE_HOST)

const proc = (mode: string, extra: { startTimeoutMs?: number; runTimeoutMs?: number } = {}) => new SandboxProcess({
  denoPath: 'deno', pyodideDir: dir, cwd: dir, denoDir: dir, ...extra,
  spawn: (_file, _args, options) => spawn(process.execPath, [hostFile, mode], { ...options, env: process.env }),
})

const rejectsWith = async (p: Promise<unknown>, code: SandboxError['code']) => {
  await assert.rejects(p, (e: unknown) => e instanceof SandboxError && e.code === code)
}

test('process: starts, runs, keeps going, and hands files both ways', async () => {
  const p = proc('ok')
  await p.start()
  const r = await p.run('print(1)', [{ name: 'in.csv', bytes: Buffer.from('a,b\n1,2\n') }])
  assert.equal(r.ok, true)
  assert.equal(r.stdout, 'ran: print(1)')
  assert.deepEqual(r.files.map((f) => [f.name, f.bytes.toString()]), [['echo-0.txt', 'a,b\n1,2\n']])
  assert.deepEqual(r.skipped, ['a.exe'])
  const again = await p.run('raise ValueError')
  assert.equal(again.ok, false)
  assert.equal(again.error, 'ValueError: boom')
  assert.equal(p.alive, true)
  p.kill()
  await p.whenExited()
  assert.equal(p.alive, false)
})

test('process: a host that cannot load Python fails the start', async () => {
  await rejectsWith(proc('fatal').start(), 'start_failed')
})

test('process: text on stdout outside a frame kills it as a protocol violation', async () => {
  const p = proc('garbage')
  await rejectsWith(p.start(), 'violation')
  assert.equal(p.alive, false)
})

test('process: a start that never says ready is killed at the start limit', async () => {
  const p = proc('silent', { startTimeoutMs: 300 })
  await rejectsWith(p.start(), 'start_failed')
  assert.equal(p.alive, false)
})

test('process: a run past its limit is killed, and the process is gone', async () => {
  const p = proc('hang', { runTimeoutMs: 300 })
  await p.start()
  const t0 = Date.now()
  await rejectsWith(p.run('while True: pass'), 'timeout')
  assert.ok(Date.now() - t0 < 5000)
  assert.equal(p.alive, false)
  await rejectsWith(p.run('1'), 'busy')
})

test('process: a frame nobody asked for kills it', async () => {
  const p = proc('unsolicited')
  await p.start().catch(() => {})
  // The result frame arrived right behind ready, with no run waiting for it.
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(p.alive, false)
})

test('process: sizes that do not add up, or an output named like a path, kill it', async () => {
  for (const mode of ['badsize', 'badname']) {
    const p = proc(mode)
    await p.start()
    await rejectsWith(p.run('x'), 'violation')
    assert.equal(p.alive, false, mode)
  }
})

test('process: a host that exits mid-run fails the run as crashed', async () => {
  const p = proc('exit')
  await p.start()
  await rejectsWith(p.run('x'), 'crashed')
})

test('process: one run at a time', async () => {
  const p = proc('hang', { runTimeoutMs: 2000 })
  await p.start()
  const first = p.run('a')
  await rejectsWith(p.run('b'), 'busy')
  p.kill()
  await first.catch(() => {})
})

test('process: Deno gets the locked-down command line and no daemon environment', () => {
  const args = denoArgs('/rt/pyodide-0.29.5', '/pkg/sandbox-host.mjs')
  for (const flag of ['--no-prompt', '--no-config', '--no-npm', '--no-remote', '--unstable-detect-cjs', '--allow-read=/rt/pyodide-0.29.5', '--v8-flags=--wasm-max-mem-pages=8192']) {
    assert.ok(args.includes(flag), flag)
  }
  assert.ok(!args.some((a) => /^--allow-(net|env|write|run|ffi|sys|all)|^-A$/.test(a)), args.join(' '))
  assert.deepEqual(args.slice(-2), ['/pkg/sandbox-host.mjs', '/rt/pyodide-0.29.5'])
  const before = process.env.TURBOLLM_TEST_SECRET
  process.env.TURBOLLM_TEST_SECRET = 'x'
  try {
    const env = denoEnv('/rt/deno-dir', 'linux')
    assert.deepEqual(Object.keys(env).sort(), ['DENO_DIR', 'DENO_NO_UPDATE_CHECK', 'NO_COLOR'])
    assert.deepEqual(Object.keys(denoEnv('/rt/deno-dir', 'win32')).sort(), ['DENO_DIR', 'DENO_NO_UPDATE_CHECK', 'NO_COLOR', 'SystemRoot'])
  } finally {
    if (before === undefined) delete process.env.TURBOLLM_TEST_SECRET
    else process.env.TURBOLLM_TEST_SECRET = before
  }
})

test('checkResult: refuses every field out of bounds', () => {
  const ok = (h: Record<string, unknown>, payload = Buffer.alloc(0)) => checkResult({ header: { size: payload.length, ...h }, payload })
  const base = { t: 'result', ok: true, stdout: 0, stderr: 0, files: [] }
  assert.ok(ok(base))
  assert.equal(ok({ ...base, t: 'ready' }), null)
  assert.equal(ok({ ...base, ok: 'yes' }), null)
  assert.equal(ok({ ...base, stdout: 70_000 }), null)
  assert.equal(ok({ ...base, files: Array.from({ length: 21 }, (_, i) => ({ name: `${i}.png`, size: 0 })) }), null)
  assert.equal(ok({ ...base, files: [{ name: '..', size: 0 }] }), null)
  assert.equal(ok({ ...base, files: [{ name: 'a/b.png', size: 0 }] }), null)
  assert.equal(ok({ ...base, files: [{ name: 'a.png', size: 26 * 1024 * 1024 }] }), null)
  assert.equal(ok({ ...base, skipped: 'x' }), null)
  assert.equal(ok({ ...base, error: 5 }), null)
  const r = ok({ ...base, stdout: 2, files: [{ name: 'chart.png', size: 3 }] }, Buffer.from('hiPNG'))
  assert.equal(r?.stdout, 'hi')
  assert.equal(r?.files[0].bytes.toString(), 'PNG')
  assert.equal(encodeFrame({ t: 'x' }).length > 4, true)
})
