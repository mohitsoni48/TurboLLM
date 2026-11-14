// The daemon's one teardown (boot.ts close), on a real test daemon (test-support/test-daemon.ts). cli.ts runs it for a
// restart (deps.requestRestart, forRestart) and for a signal shutdown (beginShutdown); before boot.ts, each path had
// its own copy, and these were source scans that both copies made the same calls. Now there is one function, and the
// tests watch it run: what it stops, what it waits for, and that the store closes and the listener releases the port
// only after. The steps a test cannot watch from here (module functions, not methods: chatTurns.abortAll,
// stopTethered, chatTurns.turnsEnded) are boot.teardown-order.test.ts's source scan of the same function.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { AttachmentJanitor } from './chat/attachment-janitor'
import { RetentionSweeper } from './chat/retention'
import { SearchIndexBackfill } from './chat/search-index-backfill'
import { UpdateScheduler } from './engines/update-scheduler'
import { bootTestDaemon, type TestDaemon } from './test-support/test-daemon'

/** Records `label` in `log` whenever `obj[name]` is called, then runs the real method. */
function watch<T extends object>(t: TestContext, obj: T, name: keyof T & string, label: string, log: string[]): void {
  const real = obj[name] as unknown as (...a: unknown[]) => unknown
  t.mock.method(obj, name as never, function (this: unknown, ...a: unknown[]) {
    log.push(label)
    return real.apply(this, a)
  } as never)
}

/** Watches every step of the teardown a test can see on a booted daemon. */
function watchTeardown(t: TestContext, d: TestDaemon, log: string[]): void {
  watch(t, UpdateScheduler.prototype, 'stop', 'stop:updates', log)
  watch(t, d.deps.routineScheduler!, 'stop', 'stop:routines', log)
  watch(t, RetentionSweeper.prototype, 'stop', 'stop:retention', log)
  watch(t, AttachmentJanitor.prototype, 'stop', 'stop:attachments', log)
  watch(t, SearchIndexBackfill.prototype, 'stop', 'stop:search-index', log)
  watch(t, d.deps.comfy!, 'stop', 'stop:comfy', log)
  watch(t, d.deps.tools!, 'disconnectAll', 'stop:mcp', log)
  watch(t, d.deps.manager, 'shutdown', 'wait:engine', log)
  watch(t, d.deps.modelRouter!, 'shutdownPool', 'wait:pool', log)
  watch(t, d.deps.remote as unknown as { disableAll(): Promise<void> }, 'disableAll', 'wait:remote', log) // the manager's, past Deps' view of it
  watch(t, d.deps.downloads, 'pauseAll', 'wait:downloads', log)
  watch(t, d.deps.db, 'close', 'store closed', log)
}

const STOPS = ['stop:updates', 'stop:routines', 'stop:retention', 'stop:attachments', 'stop:search-index', 'stop:comfy', 'stop:mcp']
const WAITS = ['wait:engine', 'wait:pool', 'wait:remote']

test('the sweepers are built on the chat store and started with the daemon', async (t) => {
  const started = (cls: { prototype: { start(): void } }) => t.mock.method(cls.prototype, 'start')
  const retention = started(RetentionSweeper)
  const attachments = started(AttachmentJanitor)
  const searchIndex = started(SearchIndexBackfill)
  const d = await bootTestDaemon()
  try {
    for (const [name, spy] of [['retention', retention], ['attachments', attachments], ['search index', searchIndex]] as const) {
      assert.equal(spy.mock.callCount(), 1, `the ${name} sweeper is started once`)
      assert.equal((spy.mock.calls[0].this as { d: { db: unknown } }).d.db, d.deps.db, `the ${name} sweeper works on the daemon's chat store`)
    }
  } finally {
    await d.stop()
  }
})

test('a shutdown stops everything recurring and the MCP servers, then waits for the engines, then closes the store and the listener', async (t) => {
  const d = await bootTestDaemon()
  const log: string[] = []
  watchTeardown(t, d, log)
  await d.close()
  assert.deepEqual(log.slice(0, STOPS.length), STOPS, 'nothing recurring fires mid-teardown')
  assert.deepEqual(log.slice(STOPS.length, STOPS.length + WAITS.length), WAITS)
  assert.equal(log.at(-1), 'store closed', 'the store closes last, once everything it waited for has ended')
  assert.ok(!log.includes('wait:downloads'), 'a shutdown does not pause downloads (the process ends)')
  assert.equal(d.listener().listening, false, 'the port is released')
})

test('a restart also stops every Code run and pauses every download, and closes the store only after their writers end', async (t) => {
  const d = await bootTestDaemon()
  const log: string[] = []
  watchTeardown(t, d, log)
  const codeRuns = d.deps.codeRuns!
  t.mock.method(codeRuns, 'activeSessionIds', () => ['session-1'])
  t.mock.method(codeRuns, 'stop', (id: string) => { log.push(`stop:code-run:${id}`) })
  await d.close({ forRestart: true })
  const codeRunStopped = log.indexOf('stop:code-run:session-1')
  assert.ok(codeRunStopped >= 0 && codeRunStopped < log.indexOf('stop:updates'), 'Code runs stop first, while the store is open')
  const paused = log.indexOf('wait:downloads')
  assert.ok(paused > log.indexOf('wait:engine') && paused < log.indexOf('store closed'), 'downloads are waited for beside the engines')
  assert.equal(log.at(-1), 'store closed')
  assert.equal(d.listener().listening, false)
})

test('the store stays open until what the caller also waits for has ended', async () => {
  const d = await bootTestDaemon()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let closed = false
  const closing = d.close({ alsoWaitFor: () => held }).then(() => { closed = true })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(closed, false, 'still waiting')
  assert.doesNotThrow(() => d.deps.db.listConversations(), 'the store is still open')
  release()
  await closing
  assert.throws(() => d.deps.db.listConversations(), 'closed once it ended')
})

test('close() is idempotent: a signal during a restart\'s teardown joins the running one, and each step runs once', async (t) => {
  const d = await bootTestDaemon()
  const log: string[] = []
  watchTeardown(t, d, log)
  const first = d.close({ forRestart: true })
  const second = d.close() // the first call's options win: this does not turn into a plain shutdown
  assert.strictEqual(second, first, 'the same promise whatever the options')
  await Promise.all([first, second])
  for (const step of [...STOPS, ...WAITS, 'wait:downloads', 'store closed']) {
    assert.equal(log.filter((l) => l === step).length, 1, `${step} ran once`)
  }
  assert.strictEqual(d.close(), first, 'and a call after it ended still returns it')
})
