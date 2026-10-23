// The restart keeper, on the real cli.ts: `node --import tsx src/cli.ts` (the `start` script) in a real pty, as a
// terminal runs it, restarted through POST /api/v1/daemon/restart.
//
// Before, a Settings restart spawned the replacement detached, without process.execArgv: under `npm start` it died
// at once with ERR_MODULE_NOT_FOUND and TurboLLM simply ended; outside tsx it ran in a session of its own, beyond
// Ctrl+C, `docker stop` and the closing of the terminal, with its output in restart.log. Now the old process stays
// as the keeper (cli.ts becomeKeeper): the replacement is its child, in the terminal's foreground job, tied to it by
// a stdin lifeline, and whatever ends the keeper ends TurboLLM gracefully.
//
// Each test boots a fresh daemon on a free port and its own data dir (HOME too), with `defaultEngineSeeded` so
// nothing is downloaded. TURBOLLM_TEST_SLOW_SHUTDOWN_MS makes every graceful shutdown take 2 s longer, so a keeper
// that exits before its replacement has finished is seen; TURBOLLM_TEST_STALL_RESTART makes the restart's teardown
// stall, so its 14 s watchdog finishes it (util/boot-env.ts).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensurePtySpawnHelper } from './terminal/pty-spawn-helper'
import { ggufVocabOnly } from './test-support/gguf-file'
import { isGone, killRecorded, pidWrittenTo, record, waitGone } from './test-support/stand-in-daemon'
import { tmpDir } from './test-support/tmp'

const require = createRequire(import.meta.url)
const TURBOLLM = fileURLToPath(new URL('..', import.meta.url))
const SLOW_MS = 2000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Pty = import('node-pty').IPty

interface Daemon {
  term: Pty
  /** The first daemon: the keeper after the first restart. */
  pid: number
  /** The daemon listening now: the first, then each replacement (restart sets it). */
  current: number
  dataDir: string
  port: number
  out(): string
  exit: Promise<{ exitCode: number; signal?: number }>
  /** When the pty's process (the keeper) exited, 0 while it runs. */
  exitedAt(): number
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function boot(env: NodeJS.ProcessEnv = {}, config: Record<string, unknown> = {}): Promise<Daemon> {
  // The step every PTYSession takes: on macOS node-pty's prebuilt spawn-helper has no exec bit as installed.
  ensurePtySpawnHelper()
  const pty = require('node-pty') as typeof import('node-pty')
  const root = tmpDir('tllm-keeper-')
  const dataDir = join(root, 'data')
  const home = join(root, 'home')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultEngineSeeded: true, ...config }))
  const port = await freePort()
  const term = pty.spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--config', join(dataDir, 'config.json'), '--port', String(port), '--no-open', '--no-telemetry'], {
    name: 'xterm-256color',
    cols: 160,
    rows: 40,
    cwd: TURBOLLM,
    env: { ...process.env, HOME: home, USERPROFILE: home, TURBOLLM_TEST_SLOW_SHUTDOWN_MS: String(SLOW_MS), ...env } as Record<string, string>,
  })
  record(term.pid)
  let out = ''
  term.onData((d) => { out += d })
  let exitedAt = 0
  const exit = new Promise<{ exitCode: number; signal?: number }>((resolve) => term.onExit((e) => { exitedAt = Date.now(); resolve(e) }))
  const d: Daemon = { term, pid: term.pid, current: term.pid, dataDir, port, out: () => out, exit, exitedAt: () => exitedAt }
  await waitFor(() => listening(d) >= 1, 60_000, 'the first daemon listens')
  return d
}

/** Windows: let go of a ConPTY whose process has exited. node-pty then closes only its output socket: its input
 *  socket, the pseudoconsole and the worker thread that reads its output stay until kill(), and they kept this file's
 *  process alive after its last case, so the run never moved past this file (CI's Windows job waited for hours).
 *  kill() itself would also kill the console's process list, by pids that may name other processes once the console's
 *  own have exited, so this does the rest of what it does (node-pty 1.1.0's WindowsPtyAgent.kill; spawning-deps.test.ts
 *  pins the version), and unrefs the worker in case its dispose does not end it. */
function releaseConpty(term: Pty): void {
  if (process.platform !== 'win32') return
  const agent = (term as unknown as { _agent?: {
    _pty: number
    _useConptyDll: boolean
    _ptyNative: { kill(pty: number, useConptyDll: boolean): void }
    _inSocket?: { destroy(): void }
    _conoutSocketWorker?: { dispose(): void; _worker?: { unref(): void } }
  } })._agent
  if (!agent) return
  try { agent._inSocket?.destroy() } catch { /* already closed */ }
  try { agent._ptyNative.kill(agent._pty, agent._useConptyDll) } catch { /* already closed */ }
  try { agent._conoutSocketWorker?.dispose() } catch { /* already disposed */ }
  try { agent._conoutSocketWorker?._worker?.unref() } catch { /* gone */ }
}

function listening(d: Daemon): number {
  return d.out().match(/listening on http/g)?.length ?? 0
}

async function waitFor(pred: () => boolean, ms: number, what: string, d?: Listening): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms${d ? `; the terminal showed:\n${d.out().slice(-3000)}` : ''}`)
    await sleep(50)
  }
}

/** The pid in the data dir's pidfile, or 0 while there is none (or one being written). */
function pidfilePid(d: Daemon): number {
  try {
    return (JSON.parse(readFileSync(join(d.dataDir, 'daemon.pid'), 'utf8')) as { pid: number }).pid
  } catch {
    return 0
  }
}

/** POST a restart, then wait for the next daemon to listen; returns its pid, from the pidfile it writes. The daemon
 *  prints that it listens just before it writes that pidfile, and the one before has removed its own: polled until it
 *  names a new process (a single read found none, under load). */
async function restart(d: Daemon, ms = 30_000): Promise<number> {
  const before = listening(d)
  const previous = d.current
  const res = await fetch(`http://127.0.0.1:${d.port}/api/v1/daemon/restart`, { method: 'POST' })
  assert.equal(res.status, 202)
  await waitFor(() => listening(d) > before || d.exitedAt() > 0, ms, 'the replacement listens', d)
  assert.equal(d.exitedAt(), 0, `the keeper is still there after the restart; the terminal showed:\n${d.out().slice(-3000)}`)
  await waitFor(() => ![0, previous, d.pid].includes(pidfilePid(d)), 10_000, 'the replacement writes its pidfile', d)
  const pid = pidfilePid(d)
  record(pid)
  d.current = pid
  return pid
}

/** The keeper exits only once its replacement has finished its graceful shutdown, with its code, and only the
 *  replacement shut down: a keeper that kept the daemon's own handlers ran a second shutdown of its own, whose
 *  server.close on a closed server exited at once (measured), cutting the replacement's short. `mark`: the terminal's
 *  output length when the ending was sent. */
async function assertKeeperOutlived(d: Daemon, replacement: number, sentAt: number, mark: number, wantCode = 0): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const e = await Promise.race([d.exit, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 20_000) })])
  clearTimeout(timer)
  assert.ok(e, `the keeper exited; the terminal showed:\n${d.out().slice(-3000)}`)
  assert.equal(isGone(replacement), true, 'the replacement was gone when the keeper exited')
  assert.ok(d.exitedAt() - sentAt >= SLOW_MS - 100, `the keeper waited for the replacement's graceful shutdown (${d.exitedAt() - sentAt} ms)`)
  assert.equal(e.exitCode, wantCode, 'the keeper exits with the replacement\'s code')
  assert.equal(d.out().slice(mark).match(/shutting down/g)?.length ?? 0, 1, `only the replacement shut down; the terminal showed:\n${d.out().slice(mark)}`)
}

/** The live processes whose command line holds `needle`, from `ps` (Linux and macOS): given the test daemon's own
 *  config path, the keeper and every daemon started for it, a replacement included. */
function processesWith(needle: string): number[] {
  const ps = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' })
  return (ps.stdout ?? '').split('\n').filter((line) => line.includes(needle))
    .map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => pid > 0 && pid !== process.pid && !isGone(pid))
}

/** A stand-in llama-server: answers /health on --port, and on SIGTERM exits by itself `termMs` later (the embedding
 *  model's `slotTermMs`), as llama-server does once its slots are freed. Each engine appends its start, its first
 *  healthy answer, its SIGTERM and that exit to `events` (one line each: what, the model's file, its pid; its port
 *  on the start line). */
const STAND_IN_ENGINE_JS = `
const http = require('http'), fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('version: 9999 (stand-in)'); process.exit(0) }
if (args.includes('--help')) { console.log('usage: llama-server [options]\\n-m, --model FNAME\\n--port PORT\\n--host HOST\\n--embeddings\\n--pooling'); process.exit(0) }
const arg = (name) => args[args.indexOf(name) + 1]
const model = path.basename(args.includes('-m') ? arg('-m') : arg('--model'))
const log = (what, more = '') => fs.appendFileSync(process.env.STAND_IN_EVENTS, what + ' ' + model + ' ' + process.pid + more + '\\n')
log('start', ' port=' + arg('--port'))
let healthy = false
http.createServer((req, res) => {
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (req.url === '/health') { if (!healthy) { healthy = true; log('healthy') } return json({ status: 'ok' }) }
  if (req.url === '/props') return json({ default_generation_settings: { n_ctx: 4096 }, total_slots: 1, chat_template: '{{x}}' })
  if (req.url === '/slots') return json([])
  if (req.url === '/v1/models' || req.url === '/models') return json({ object: 'list', data: [{ id: 'stand-in', object: 'model' }] })
  json({}, 404)
}).listen(Number(arg('--port')), args.includes('--host') ? arg('--host') : '127.0.0.1')
process.on('SIGTERM', () => {
  log('SIGTERM')
  setTimeout(() => { log('exit-by-itself'); process.exit(0) }, Number(/^bge/.test(model) ? process.env.STAND_IN_SLOT_TERM_MS : process.env.STAND_IN_TERM_MS))
})
`

interface StandInEngines {
  /** config.json entries: the engine, selected, and the models' folder. */
  config: Record<string, unknown>
  /** Environment for the daemon (its engines inherit it). */
  env: NodeJS.ProcessEnv
  /** How many `what` lines the engines logged after `from` (an earlier count of every line). */
  count(what: string, from?: number): number
  /** Every line so far. */
  lines(): number
  /** Every engine pid logged so far. */
  pids(): number[]
}

/** The stand-in engine, a chat model and an embedding model, which loads into a pool slot of its own beside it. */
function standInEngines(o: { termMs: number; slotTermMs: number }): StandInEngines {
  const root = tmpDir('tllm-keeper-engine-')
  const models = join(root, 'models')
  mkdirSync(models)
  const events = join(root, 'events.log')
  writeFileSync(events, '')
  writeFileSync(join(root, 'engine.cjs'), STAND_IN_ENGINE_JS)
  const bin = join(root, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'engine.cjs')}" "$@"\n`)
  chmodSync(bin, 0o755)
  const template = '{% for m in messages %}{{m.content}}{% endfor %}'
  const gguf = (arch: string, name: string) => {
    const head = ggufVocabOnly([['general.architecture', arch], ['general.name', name], [`${arch}.context_length`, 4096], ['qwen2.block_count', 24],
      ['qwen2.attention.head_count', 14], ['qwen2.attention.head_count_kv', 2], ['qwen2.embedding_length', 896], ['general.file_type', 15], ['tokenizer.chat_template', template]])
    return Buffer.concat([head, Buffer.alloc(2 * 1024 * 1024 - head.length)])
  }
  writeFileSync(join(models, 'StandInChat-0.5B-Q4_K_M.gguf'), gguf('qwen2', 'Stand-in Chat 0.5B'))
  writeFileSync(join(models, 'bge-small-standin-Q8_0.gguf'), gguf('bert', 'bge small stand-in'))
  const flags = ['--cache-type-k', '--ctx-size', '--flash-attn', '--gpu-layers', '--host', '--jinja', '--metrics', '--model', '--port', '--slots', '--embeddings', '--pooling']
  const booleans = new Set(['--flash-attn', '--jinja', '--metrics', '--slots', '--embeddings'])
  const engine = {
    id: '00000000-0000-4000-8000-00000000e001', name: 'Stand-in', binPath: bin, kind: 'llama-server', version: '9999 (stand-in)',
    capabilities: { kvTypes: ['f16'], flags, flagInfo: flags.map((name) => ({ name, kind: booleans.has(name) ? 'boolean' : 'valued' })) },
    addedAt: new Date().toISOString(), updatePolicy: 'notify',
  }
  const all = () => readFileSync(events, 'utf8').split('\n').filter(Boolean)
  return {
    config: { engines: [engine], activeEngineId: engine.id, modelDirs: [models], primaryModelDir: models, appUpdate: { policy: 'off', dismissedVersion: '' } },
    env: { STAND_IN_EVENTS: events, STAND_IN_TERM_MS: String(o.termMs), STAND_IN_SLOT_TERM_MS: String(o.slotTermMs) },
    count: (what, from = 0) => all().slice(from).filter((line) => line.startsWith(`${what} `)).length,
    lines: () => all().length,
    pids: () => all().map((line) => Number(line.split(' ')[2])),
  }
}

/** What loadEngines and restartUntilEnginesStop need of a daemon, in a terminal or not. */
interface Listening {
  port: number
  out(): string
}

/** Load the chat model, then the embedding model beside it (a pool slot), in the daemon listening now. */
async function loadEngines(d: Listening, e: StandInEngines): Promise<void> {
  const from = e.lines()
  const url = (path: string) => `http://127.0.0.1:${d.port}${path}`
  let models: Array<{ key: string }> = []
  const deadline = Date.now() + 30_000
  while (models.length < 2) {
    assert.ok(Date.now() < deadline, `the boot scan lists both models; the terminal showed:\n${d.out().slice(-3000)}`)
    await sleep(200)
    models = ((await (await fetch(url('/api/v1/models'))).json()) as { models?: Array<{ key: string }> }).models ?? []
  }
  const start = async (re: RegExp) => {
    const m = models.find((x) => re.test(JSON.stringify(x)))
    assert.ok(m, `a model matching ${re}`)
    // A port of its own, from the OS's ephemeral range: two test files walking 8081+ at once could hand two engines
    // the same one (test-support/stand-in-engine.ts freePort).
    const body = { modelKey: m.key, profileOverrides: { port: await freePort() } }
    const res = await fetch(url('/api/v1/engine/start'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.ok(res.ok, `the start of ${m.key} answered ${res.status}`)
  }
  await start(/StandInChat/)
  await waitFor(() => e.count('healthy', from) >= 1, 30_000, 'the chat model loads', d)
  await start(/bge-small/)
  await waitFor(() => e.count('healthy', from) >= 2, 30_000, 'the embedding model loads beside it, in a pool slot', d)
  await sleep(500) // the slot is registered once its first health check has answered
  record(...e.pids())
}

const posix = process.platform === 'win32' ? 'POSIX signals (Windows: the ConPTY case below)' : false

test('after a restart, Ctrl+C ends the keeper and its replacement gracefully; a second restart is started by the same keeper', { skip: posix, timeout: 120_000 }, async () => {
  const d = await boot()
  try {
    const second = await restart(d)
    assert.ok(!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(d.out()), 'the replacement loaded its TypeScript (execArgv reached it)')
    const third = await restart(d)
    assert.equal(isGone(second), true, 'the second daemon exited (75) for the keeper to start the third')
    assert.equal(isGone(d.pid), false, 'the same keeper')
    const at = Date.now()
    const mark = d.out().length
    d.term.write('\x03')
    await assertKeeperOutlived(d, third, at, mark)
    assert.match(d.out(), /shutting down/, 'the replacement ran its graceful shutdown, in this terminal')
    assert.deepEqual(await waitGone([d.pid, second, third], 2000), [], 'nothing is left')
  } finally {
    killRecorded()
  }
})

test('after a restart, SIGTERM to the keeper (what docker stop sends through tini) ends both gracefully', { skip: posix, timeout: 90_000 }, async () => {
  const d = await boot()
  try {
    const replacement = await restart(d)
    const at = Date.now()
    const mark = d.out().length
    process.kill(d.pid, 'SIGTERM')
    await assertKeeperOutlived(d, replacement, at, mark)
    assert.deepEqual(await waitGone([d.pid, replacement], 2000), [], 'nothing is left')
  } finally {
    killRecorded()
  }
})

// The keeper is the old process, and every recurring tick of the old process ran on in it: with the ext API on, the
// reaper (every 30 s) pruned the audit table of the chat store the keeper had closed, threw from its timer ("database
// is not open"), and ended the keeper, and TurboLLM with it (the replacement's stdin lifeline ended).
test('after a restart with the ext API on, the keeper outlives the old daemon\'s 30 s ext reaper tick, and Ctrl+C still ends both gracefully', { skip: posix, timeout: 120_000 }, async () => {
  const d = await boot({}, { api: { ext: { enabled: true } } })
  try {
    assert.match(d.out(), /\[ext-api\] \/api\/ext\/v1 is enabled/, 'the ext API is on')
    const replacement = await restart(d)
    await sleep(31_000) // past the old daemon's next reaper tick, whenever it falls
    assert.equal(d.exitedAt(), 0, `the keeper is still there; the terminal showed:\n${d.out().slice(-3000)}`)
    assert.equal(isGone(replacement), false, 'and so is its replacement')
    assert.ok(!/database is not open|keeper: an error/.test(d.out()), `nothing of the old daemon ran on the closed store; the terminal showed:\n${d.out().slice(-3000)}`)
    const at = Date.now()
    const mark = d.out().length
    d.term.write('\x03')
    await assertKeeperOutlived(d, replacement, at, mark)
    assert.deepEqual(await waitGone([d.pid, replacement], 2000), [], 'nothing is left')
  } finally {
    killRecorded()
  }
})

test('after a restart, a SIGKILLed keeper still ends its replacement gracefully: its stdin lifeline ends',{ skip: posix, timeout: 90_000 }, async () => {
  const d = await boot()
  try {
    const replacement = await restart(d)
    process.kill(d.pid, 'SIGKILL')
    // stdin EOF, and, the pty's session leader gone, the kernel's hangup too: whichever comes first runs the graceful
    // shutdown (2 s longer here). The next test has the lifeline alone, with no terminal.
    assert.deepEqual(await waitGone([replacement], SLOW_MS + 8000), [], 'the replacement ended')
    assert.match(d.out(), /shutting down( \(the keeper ended\))?\r?\n/, 'gracefully')
  } finally {
    killRecorded()
  }
})

// The same lifeline with nothing else in play (no terminal, so no hangup): a daemon whose parent holds its stdin, as
// the desktop app does and a keeper in a container does, shuts down gracefully when that parent is killed. On Windows
// the parent's kill-on-close job ends the daemon instead (the desktop app's case there).
test('a daemon whose parent holds its stdin lifeline shuts down gracefully when that parent is SIGKILLed', { skip: posix, timeout: 90_000 }, async () => {
  const root = tmpDir('tllm-lifeline-')
  const dataDir = join(root, 'data')
  const home = join(root, 'home')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultEngineSeeded: true }))
  const port = await freePort()
  const log = join(root, 'daemon.log')
  const daemonPidFile = join(root, 'daemon.pid')
  const parent = spawn(process.execPath, ['-e', `
    const { openSync, writeFileSync } = require('node:fs')
    const out = openSync(${JSON.stringify(log)}, 'a')
    const child = require('node:child_process').spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--config', ${JSON.stringify(join(dataDir, 'config.json'))}, '--port', '${port}', '--no-open', '--no-telemetry'], {
      cwd: ${JSON.stringify(TURBOLLM)},
      stdio: ['pipe', out, out],
      env: { ...process.env, HOME: ${JSON.stringify(home)}, TURBOLLM_DESKTOP: '1', TURBOLLM_LIFELINE: 'stdin:' + process.pid },
    })
    writeFileSync(${JSON.stringify(daemonPidFile)}, String(child.pid))
    setInterval(() => {}, 1e9)
  `], { stdio: 'ignore' })
  record(parent.pid)
  try {
    const daemon = await pidWrittenTo(daemonPidFile)
    record(daemon)
    const text = () => { try { return readFileSync(log, 'utf8') } catch { return '' } }
    await waitFor(() => /listening on http/.test(text()), 60_000, 'the daemon listens')
    process.kill(parent.pid as number, 'SIGKILL')
    assert.deepEqual(await waitGone([daemon], SLOW_MS + 8000), [], 'the daemon ended with its parent')
    assert.match(text(), /shutting down \(the desktop app closed\)/, 'by its stdin lifeline, gracefully')
  } finally {
    killRecorded()
  }
})

test('after a restart, closing the terminal ends the keeper and its replacement', { skip: posix, timeout: 90_000 }, async () => {
  const d = await boot()
  try {
    const replacement = await restart(d)
    // Closes the master side, as a closed terminal window does (then node-pty hangs the keeper up too).
    ;(d.term as unknown as { destroy(): void }).destroy()
    assert.deepEqual(await waitGone([d.pid, replacement], SLOW_MS + 8000), [], 'nothing is left')
  } finally {
    killRecorded()
  }
})

// The same terminal closed before any restart. The hangup's shutdown printed "shutting down" to the hung-up tty: the
// write failed with EIO, no 'error' listener was there to take it, and the uncaught exception ended the daemon
// within milliseconds, its teardown never run (replies not saved as stopped, engines SIGKILLed by the exit handler).
test('closing the terminal of a daemon that was never restarted runs its graceful shutdown', { skip: posix, timeout: 90_000 }, async () => {
  const d = await boot()
  try {
    const at = Date.now()
    ;(d.term as unknown as { destroy(): void }).destroy()
    let timer: ReturnType<typeof setTimeout> | undefined
    const e = await Promise.race([d.exit, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SLOW_MS + 10_000) })])
    clearTimeout(timer)
    assert.ok(e, 'the daemon ended')
    assert.equal(e.exitCode, 0, 'it exited by its own shutdown, not by an uncaught write error (exit 1)')
    assert.ok(d.exitedAt() - at >= SLOW_MS - 100, `after its graceful shutdown (${d.exitedAt() - at} ms)`)
  } finally {
    killRecorded()
  }
})

test('a restart whose teardown stalls: the keeper kills what the old daemon left (a wedged engine) before the replacement starts, and binds nothing itself', { skip: posix, timeout: 120_000 }, async () => {
  const d = await boot({ TURBOLLM_TEST_STALL_RESTART: '1' })
  let engine = 0
  try {
    // A stand-in engine that ignores SIGTERM, recorded as writeEnginePid records one: owned by this daemon.
    const pidFile = join(d.dataDir, 'engine-standin.pid')
    const e = spawn('/bin/sh', ['-c', `echo $$ > ${JSON.stringify(pidFile)}; trap "" TERM; while :; do sleep 1; done`], { detached: true, stdio: 'ignore' })
    e.unref()
    engine = await pidWrittenTo(pidFile)
    record(engine)
    mkdirSync(join(d.dataDir, 'run'), { recursive: true })
    writeFileSync(join(d.dataDir, 'run', `engine-${engine}.pid`), JSON.stringify({ pid: engine, port: 0, owner: d.pid, startedAt: Date.now(), group: true }))
    // When the engine was first seen gone, and when the replacement first printed that it listens.
    let engineGoneAt = 0
    let replacementAt = 0
    const before = listening(d)
    const outBefore = d.out().length
    const watch = setInterval(() => {
      if (!engineGoneAt && isGone(engine)) engineGoneAt = Date.now()
      if (!replacementAt && listening(d) > before) replacementAt = Date.now()
    }, 20)
    let replacement = 0
    try {
      replacement = await restart(d, 40_000) // the 14 s watchdog, then the boot
    } finally {
      clearInterval(watch)
    }
    replacementAt ||= Date.now()
    assert.ok(engineGoneAt > 0 && engineGoneAt <= replacementAt,
      `the wedged engine was killed before the replacement started (gone at ${engineGoneAt ? engineGoneAt - replacementAt : 'never'} ms from the replacement's listen)`)
    assert.ok(!/already running|Port \d+ busy/.test(d.out().slice(outBefore)), 'the replacement found no pidfile and a free port')
    const at = Date.now()
    const mark = d.out().length
    d.term.write('\x03')
    await assertKeeperOutlived(d, replacement, at, mark)
    assert.deepEqual(await waitGone([d.pid, replacement, engine], 2000), [], 'nothing is left')
  } finally {
    killRecorded(engine)
  }
})

// A signal during a restart's teardown. Both teardowns waited on the same engine exits (the pool slot's, which
// exits last here) and both ended in one server 'close': the restart's finish() became the keeper and spawned the
// replacement, and the shutdown's exit ended that keeper in the same tick. The replacement ran on, parented to init,
// its lifeline ignored ("does not name this process's parent (pid 1)"), serving the port. Now the signal wins.
const ENGINE_TERM_MS = 2500
const SLOT_TERM_MS = 4000

/** POST a restart of the daemon listening now and wait until its teardown has sent both engines SIGTERM. */
async function restartUntilEnginesStop(d: Listening, e: StandInEngines): Promise<void> {
  const from = e.lines()
  const res = await fetch(`http://127.0.0.1:${d.port}/api/v1/daemon/restart`, { method: 'POST' })
  assert.equal(res.status, 202)
  await waitFor(() => e.count('SIGTERM', from) >= 2, 10_000, "the restart's teardown stops the engine and the pool slot", d)
}

/** The daemon with no terminal, in a session of its own, as in a container, a service or under nohup: its output
 *  comes here. In a pty the daemon leads the session, so a stray replacement died of the hangup at its keeper's exit
 *  (measured); under `npm start` the interactive shell leads it, and nothing hangs the replacement up. */
async function bootNoTerminal(env: NodeJS.ProcessEnv, config: Record<string, unknown>): Promise<Listening & { pid: number; dataDir: string; exit: Promise<number | null> }> {
  const root = tmpDir('tllm-keeper-')
  const dataDir = join(root, 'data')
  const home = join(root, 'home')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultEngineSeeded: true, ...config }))
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--config', join(dataDir, 'config.json'), '--port', String(port), '--no-open', '--no-telemetry'], {
    cwd: TURBOLLM,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, USERPROFILE: home, TURBOLLM_TEST_SLOW_SHUTDOWN_MS: String(SLOW_MS), ...env },
  })
  record(child.pid)
  let out = ''
  child.stdout?.on('data', (b: Buffer) => { out += b.toString() })
  child.stderr?.on('data', (b: Buffer) => { out += b.toString() })
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  const d = { pid: child.pid as number, dataDir, port, out: () => out, exit }
  await waitFor(() => /listening on http/.test(out), 60_000, 'the daemon listens', d)
  return d
}

test('a signal during a restart whose engine and pool slot are still stopping ends TurboLLM: no replacement starts (no terminal: a container, a service)', { skip: posix, timeout: 120_000 }, async () => {
  const e = standInEngines({ termMs: ENGINE_TERM_MS, slotTermMs: SLOT_TERM_MS })
  const d = await bootNoTerminal(e.env, e.config)
  const config = join(d.dataDir, 'config.json')
  try {
    await loadEngines(d, e)
    const from = e.lines()
    await restartUntilEnginesStop(d, e)
    const mark = d.out().length
    process.kill(-d.pid, 'SIGINT') // what Ctrl+C sends: the job's process group
    let timer: ReturnType<typeof setTimeout> | undefined
    const code = await Promise.race([d.exit, new Promise<'none'>((resolve) => { timer = setTimeout(() => resolve('none'), 20_000) })])
    clearTimeout(timer)
    const left = processesWith(config)
    record(...left, ...e.pids())
    assert.deepEqual(left, [], `no replacement daemon was started; the daemon wrote:\n${d.out().slice(mark)}`)
    assert.equal(code, 0, `TurboLLM ended, with 0; the daemon wrote:\n${d.out().slice(-3000)}`)
    assert.equal(e.count('exit-by-itself', from), 2, 'the engine and the pool slot exited by themselves, before TurboLLM did')
    assert.equal(d.out().slice(mark).match(/shutting down/g)?.length ?? 0, 1, 'one graceful shutdown')
    assert.deepEqual(await waitGone([d.pid, ...e.pids()], 2000), [], 'nothing is left')
  } finally {
    killRecorded(...processesWith(config))
  }
})

// The same race in a replacement under the keeper: its restart's finish() exited 75 after it had printed "shutting
// down", and the keeper started another daemon, still running after the Ctrl+C.
test('after a restart, Ctrl+C during the next restart, its engine and pool slot still stopping, ends the keeper and its replacement: no other daemon starts', { skip: posix, timeout: 150_000 }, async () => {
  const e = standInEngines({ termMs: ENGINE_TERM_MS, slotTermMs: SLOT_TERM_MS })
  const d = await boot(e.env, e.config)
  const config = join(d.dataDir, 'config.json')
  try {
    const replacement = await restart(d)
    await loadEngines(d, e)
    const from = e.lines()
    await restartUntilEnginesStop(d, e)
    const at = Date.now()
    const mark = d.out().length
    d.term.write('\x03')
    await assertKeeperOutlived(d, replacement, at, mark)
    const left = processesWith(config)
    record(...left)
    assert.deepEqual(left, [], 'the keeper started no other daemon')
    assert.ok(!/Restarting: exiting with code/.test(d.out().slice(mark)), 'the replacement did not exit for a restart')
    assert.equal(e.count('exit-by-itself', from), 2, 'the engine and the pool slot exited by themselves')
    assert.deepEqual(await waitGone([d.pid, replacement, ...e.pids()], 2000), [], 'nothing is left')
  } finally {
    killRecorded(...processesWith(config))
  }
})

// `turbollm --stop` signals the daemon its pidfile names: the keeper's replacement, and only it. A restart's finish()
// that came after it exited 75, and the keeper, told nothing, started the next daemon.
test('after a restart, SIGTERM to the replacement (what turbollm --stop sends) during its next restart ends TurboLLM: the keeper starts no other daemon', { skip: posix, timeout: 150_000 }, async () => {
  const e = standInEngines({ termMs: ENGINE_TERM_MS, slotTermMs: SLOT_TERM_MS })
  const d = await boot(e.env, e.config)
  const config = join(d.dataDir, 'config.json')
  try {
    const replacement = await restart(d)
    await loadEngines(d, e)
    await restartUntilEnginesStop(d, e)
    const at = Date.now()
    const mark = d.out().length
    process.kill(replacement, 'SIGTERM')
    await assertKeeperOutlived(d, replacement, at, mark)
    const left = processesWith(config)
    record(...left)
    assert.deepEqual(left, [], 'the keeper started no other daemon')
    assert.deepEqual(await waitGone([d.pid, replacement, ...e.pids()], 2000), [], 'nothing is left')
  } finally {
    killRecorded(...processesWith(config))
  }
})

// Windows: the console delivers Ctrl+C to the replacement itself, which sits in the keeper's kill-on-close job, so the
// keeper ignores it and must stay until the replacement has finished (only CI's windows-latest runs this).
test('Windows: after a restart, ConPTY Ctrl+C ends the replacement gracefully, and the keeper waits for it', { skip: process.platform === 'win32' ? false : 'Windows ConPTY', timeout: 120_000 }, async () => {
  const d = await boot()
  try {
    const replacement = await restart(d)
    const at = Date.now()
    const mark = d.out().length
    d.term.write('\x03')
    await assertKeeperOutlived(d, replacement, at, mark)
    assert.match(d.out(), /shutting down/, 'the replacement ran its graceful shutdown')
  } finally {
    killRecorded()
    releaseConpty(d.term)
  }
})
