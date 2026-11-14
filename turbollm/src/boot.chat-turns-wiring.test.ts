// bootDaemon builds ONE ChatTurns and ONE ChatRuns (scalability review 5.4) and hands the same two to everything that
// reads them. Driven on a real test daemon (test-support/test-daemon.ts): a turn registered on `deps` shows up through
// the engine manager's idle hold, the activity probe route and the chat stream route, and a second daemon does not see it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootTestDaemon } from './test-support/test-daemon'

test('the engine manager, the activity route and the chat stream route all read the daemon\'s own chatTurns and chatRuns', async () => {
  const d = await bootTestDaemon()
  try {
    const conv = d.deps.db.createConversation()
    const ac = new AbortController()
    d.deps.chatTurns.claim(conv.id, ac, 'reply-1')
    const { run, sink } = d.deps.chatRuns.start(conv.id, ac, { userMessageId: 'u1', assistantMessageId: 'reply-1' })

    assert.equal(d.deps.manager.holdsEngine!(), true, 'the idle watchdog reads chatTurns')

    const activity = await (await fetch(`${d.origin}/api/v1/activity`)).json() as { items: { kind: string; id: string }[] }
    assert.ok(activity.items.some((i) => i.kind === 'chat' && i.id === conv.id), 'the activity probe lists the in-flight chat')

    sink({ event: 'delta', data: { content: 'hi' } })
    d.deps.chatTurns.release(conv.id, ac)
    d.deps.chatRuns.end(run)
    const stream = await fetch(`${d.origin}/api/v1/conversations/${conv.id}/stream?run=reply-1`)
    const text = await stream.text()
    assert.match(text, /event: meta/)
    assert.match(text, /event: delta/, 'the stream route replays the run the test started on deps.chatRuns')

    assert.equal(d.deps.manager.holdsEngine!(), false)
  } finally {
    await d.stop()
  }
})

test('two daemons share no chat turns or runs', async () => {
  const a = await bootTestDaemon()
  const b = await bootTestDaemon()
  try {
    assert.notEqual(a.deps.chatTurns, b.deps.chatTurns)
    assert.notEqual(a.deps.chatRuns, b.deps.chatRuns)
    a.deps.chatTurns.claim('c', new AbortController(), 'r')
    assert.deepEqual(b.deps.chatTurns.inFlightChatIds(), [])
  } finally {
    await a.stop()
    await b.stop()
  }
})
