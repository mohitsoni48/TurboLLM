// ChatTurns: the registry of running chat turns (scalability review 5.4). The behaviors here were module state in
// chat-routes.ts; chat-routes.test.ts and chat-routes.detached.test.ts drive them through the routes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatTurns } from './chat-turns.js'

test('claim holds a chat slot, slotState reports the reply, release frees it only for its own entry', () => {
  const turns = new ChatTurns()
  const a = new AbortController()
  const b = new AbortController()
  turns.claim('c1', a, 'reply-a')
  assert.deepEqual(turns.inFlightChatIds(), ['c1'])
  assert.deepEqual(turns.slotState('c1'), { runningReplyId: 'reply-a', compacting: false })
  turns.stop('c1', a)
  assert.equal(a.signal.aborted, true)
  assert.deepEqual(turns.slotState('c1'), { runningReplyId: null, compacting: false })
  // The stopped turn unwinds after the next turn took the slot: its release must leave the next turn's entry.
  turns.claim('c1', b, 'reply-b')
  turns.release('c1', a)
  assert.deepEqual(turns.inFlightChatIds(), ['c1'])
  turns.release('c1', b)
  assert.deepEqual(turns.inFlightChatIds(), [])
})

test('a manual compaction holds the slot and reports compacting, not a running reply', () => {
  const turns = new ChatTurns()
  const ac = new AbortController()
  turns.claimForCompaction('c1', ac)
  assert.equal(turns.isCompaction(ac), true)
  assert.deepEqual(turns.slotState('c1'), { runningReplyId: null, compacting: true })
  assert.equal(turns.holdsEngine(), true)
})

test('autoCompactionPhase tags the entry from start to end, and passes the phase to write', async () => {
  const turns = new ChatTurns()
  const ac = new AbortController()
  const phases: string[] = []
  const phase = turns.autoCompactionPhase(ac, async (p) => { phases.push(p) })
  await phase('start')
  assert.equal(turns.isAutoCompacting(ac), true)
  await phase('end')
  assert.equal(turns.isAutoCompacting(ac), false)
  assert.deepEqual(phases, ['start', 'end'])
})

test('abortAll aborts and clears every entry and counts them; abort leaves the entry for its turn to release', () => {
  const turns = new ChatTurns()
  const a = new AbortController()
  const b = new AbortController()
  turns.claim('c1', a, 'ra')
  turns.claim('c2', b, 'rb')
  turns.abort('c1')
  assert.equal(a.signal.aborted, true)
  assert.deepEqual(turns.inFlightChatIds(), ['c1', 'c2'])
  assert.equal(turns.abortAll(), 2)
  assert.equal(b.signal.aborted, true)
  assert.deepEqual(turns.inFlightChatIds(), [])
})

test('an approval wait lists the chat as parked, and a local turn counts out of the engine generations', () => {
  const turns = new ChatTurns()
  const ac = new AbortController()
  turns.claim('c1', ac, 'r')
  turns.setApprovalWait(ac, true, true)
  assert.deepEqual(turns.parkedChatIds(), ['c1'])
  assert.equal(turns.parkedEngineTurns(), 1)
  turns.setApprovalWait(ac, false, true)
  assert.deepEqual(turns.parkedChatIds(), [])
  assert.equal(turns.parkedEngineTurns(), 0)
  // A turn that is not on the local engine parks without touching the engine's count.
  turns.setApprovalWait(ac, true, false)
  assert.equal(turns.parkedEngineTurns(), 0)
})

test('afterReplyCall counts the chat until its call settles, as the idle watchdog reads it', async () => {
  const turns = new ChatTurns()
  let finish!: () => void
  const call = () => new Promise<void>((resolve) => { finish = resolve })
  turns.afterReplyCall('c1', 0, call)
  turns.afterReplyCall('c1', 0, async () => {})
  assert.deepEqual(turns.afterReplyChatIds(), ['c1'])
  assert.equal(turns.holdsEngine(), true)
  await new Promise((r) => setTimeout(r, 20))
  finish()
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(turns.afterReplyChatIds(), [])
  assert.equal(turns.holdsEngine(), false)
})

test('turnsEnded resolves at once when idle, waits for a running turn, and gives up after its bound', async () => {
  const turns = new ChatTurns()
  await turns.turnsEnded()
  let end!: () => void
  const turn = new Promise<void>((resolve) => { end = resolve })
  turns.trackTurn(turn)
  const t0 = Date.now()
  await turns.turnsEnded(30)
  assert.ok(Date.now() - t0 >= 25, 'a running turn is waited for up to the bound')
  let ended = false
  const waiting = turns.turnsEnded(5_000).then(() => { ended = true })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(ended, false)
  end()
  await waiting
  assert.equal(ended, true)
  turns.untrackTurn(turn)
})

test('saveRunningReplies runs each registered save until it is removed', () => {
  const turns = new ChatTurns()
  let n = 0
  const save = () => { n++ }
  turns.addReplySave(save)
  turns.saveRunningReplies()
  turns.removeReplySave(save)
  turns.saveRunningReplies()
  assert.equal(n, 1)
})

test('two instances share nothing', () => {
  const one = new ChatTurns()
  const two = new ChatTurns()
  one.claim('c1', new AbortController(), 'r')
  assert.deepEqual(two.inFlightChatIds(), [])
  assert.equal(two.holdsEngine(), false)
})
