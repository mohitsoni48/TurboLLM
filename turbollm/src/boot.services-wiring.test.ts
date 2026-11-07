// How bootDaemon (boot.ts) wires its services to each other, on a real test daemon (test-support/test-daemon.ts).
// These were source scans of cli.ts while it built the daemon in top-level code (cli.idle-hold-wiring,
// cli.comfy-wiring, cli.daily-active-wiring): each one now calls the wired thing and watches where the call goes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Emitter } from './telemetry/emit'
import { bootTestDaemon } from './test-support/test-daemon'

// The idle unload waits while a chat needs the model (Manager.holdsEngine): the generation count covers a turn's
// requests and approval waits, not the auto-compaction before them or the title and memory calls after. The behaviour
// is engines/manager.idle.test.ts's and chat/chat-routes.detached.test.ts's.
test("the primary Manager is given the chat's engine hold", async () => {
  const d = await bootTestDaemon()
  try {
    const hold = d.deps.manager.holdsEngine!
    assert.equal(hold(), false)
    d.deps.chatTurns.claim('conv-1', new AbortController(), 'reply-1')
    assert.equal(hold(), true, "the manager reads the daemon's own chatTurns")
  } finally {
    await d.stop()
  }
})

/** What ComfyGuard was handed by the boot (private fields, called here as the guard calls them). */
interface ComfyWiring {
  swapLock: (<T>(fn: () => Promise<T>) => Promise<T>) | null
  engineLookup: ((id: string) => unknown) | null
  onReloaded: ((modelKey: string, engineId: string) => void) | null
}

// The reload when a render ends: under the gateway's swap lock (a gateway request for that model waits instead of
// loading a second copy), only onto an engine still registered, and recorded by the router as the model it brought
// up. The behaviour is gateway/model-router.comfy-reload.test.ts's, against a guard and router wired the same way.
test("the ComfyUI guard's reload after a render runs under the router's swap lock, checks the registry, and reports to the router", async (t) => {
  const d = await bootTestDaemon()
  try {
    const comfy = d.deps.comfy as unknown as ComfyWiring
    const router = d.deps.modelRouter!
    const locked = t.mock.method(router, 'withSwapLock', async <T>(fn: () => Promise<T>) => fn())
    assert.equal(await comfy.swapLock!(async () => 'ran'), 'ran')
    assert.equal(locked.mock.callCount(), 1, 'the swap lock is the router\'s')

    const looked = t.mock.method(d.deps.registry, 'get', () => undefined)
    assert.equal(comfy.engineLookup!('engine-1'), undefined)
    assert.deepEqual(looked.mock.calls.map((c) => c.arguments), [['engine-1']], 'the lookup is the registry\'s')

    const reported = t.mock.method(router, 'reloadedAfterRender', () => {})
    comfy.onReloaded!('model-a', 'engine-1')
    assert.deepEqual(reported.mock.calls.map((c) => c.arguments), [['model-a', 'engine-1']])
  } finally {
    await d.stop()
  }
})

// daily_active is idempotent per day, but its only call used to be at boot: a daemon left running across midnight
// was counted on its boot day only. It rides a daemonTick, which the restart keeper stops.
test('daily_active is re-checked on a recurring timer, not only at boot', async (t) => {
  const daily = t.mock.method(Emitter.prototype, 'dailyActive')
  t.mock.timers.enable({ apis: ['setInterval'] })
  const d = await bootTestDaemon()
  try {
    assert.equal(daily.mock.callCount(), 1, 'once at boot')
    t.mock.timers.tick(5 * 60_000)
    assert.equal(daily.mock.callCount(), 2, 'and again on the 5-minute tick')
  } finally {
    t.mock.timers.reset()
    await d.stop()
  }
})

// The chat store the daemon builds announces its writes on the invalidation bus GET /api/v1/events streams
// (review 4.14), so a reply finished by a detached turn or a routine reaches an open page without its poll.
// The per-method keys are events/chat-store-announcer.test.ts's.
test("the daemon's chat store announces its writes on the invalidation bus", async (t) => {
  const { COALESCE_WINDOW_MS, eventBus } = await import('./events/bus')
  const d = await bootTestDaemon()
  try {
    const heard = new Set<string>()
    t.after(eventBus.subscribe((keys) => { for (const k of keys) heard.add(k) }))
    const conv = d.deps.db.createConversation({ title: 'wired' })
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50))
    assert.ok(heard.has(`conversation:${conv.id}`), `heard ${[...heard].join(', ')}`)
  } finally {
    await d.stop()
  }
})
