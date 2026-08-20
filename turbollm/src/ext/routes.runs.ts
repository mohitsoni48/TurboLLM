// turbollm/src/ext/routes.runs.ts
//
// The generating path (spec 27 §5.1, §6, §8).
//
// Order is load-bearing:
//   1. validate  2. persist user + placeholder  3. create the run  4. acquire the gate
//   5. generate  6. release  7. terminal write
// Persisting before touching the engine (§7.4) means a failed write costs zero GPU time, and
// releasing before the terminal write keeps adapter I/O outside the gate hold (§8.2). Note that
// steps 4/6/7 happen INSIDE the injected run body (generation.ts in production; the tests here
// inject a fake body) — this route never touches `d.gate` itself.
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps.js'
import { requireScope, scopeFor } from './auth.js'
import { extError, mapStoreError } from './errors.js'
import { PublicRunManager, type PublicRun, type RunBody } from './run-manager.js'

const BASE = '/api/ext/v1'

export interface RunDeps {
  /** Builds the body the manager drives. Injected so route tests need no model. */
  makeBody: (args: { chatId: string; messageId: string; scope: { tenant: string; owner: string } }) => RunBody
}

function toRunDTO(r: PublicRun): Record<string, unknown> {
  return {
    id: r.id, chat_id: r.chatId, message_id: r.messageId, status: r.status,
    event_seq: r.eventSeq, error: r.error, created_at: r.createdAt, ended_at: r.endedAt,
  }
}

export function registerExtRunRoutes(app: Hono, d: Deps, runs: PublicRunManager, rd: RunDeps): void {
  /** One active run per chat, mirroring the internal `inflight` 409. */
  const inflight = new Map<string, string>()

  app.post(`${BASE}/chats/:id/messages/generate`, requireScope('runs:write'), async (c) => {
    const chatId = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as { role?: 'user'; content?: string; owner?: string }
    const scope = scopeFor(c, b.owner)
    const content = (b.content ?? '').trim()

    if (!content) return extError(c, 'invalid_request', 'invalid_input', 'Type a message or attach a file.', { param: 'content' })

    const chat = await d.chatStore.getChat(scope, chatId)
    if (!chat) return extError(c, 'not_found', 'not_found', 'Not found.')

    if (inflight.has(chatId)) {
      return extError(c, 'conflict', 'generation_in_flight', 'A generation is already running for this chat.', { retryable: true })
    }

    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) {
      return extError(c, 'conflict', 'model_not_loaded', 'Load a model first.', { retryable: true })
    }

    // 2. Persist BEFORE the engine is touched. A failed write here costs no GPU time and
    //    leaves the caller with nothing dangling.
    let userMsgId: string
    let assistantMsgId: string
    try {
      const user = await d.chatStore.addMessage(scope, chatId, { role: 'user', content })
      const placeholder = await d.chatStore.addMessage(scope, chatId, { role: 'assistant', content: '', status: 'streaming' })
      userMsgId = user.id
      assistantMsgId = placeholder.id
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }

    const run = runs.start({
      scope, chatId, messageId: assistantMsgId,
      body: rd.makeBody({ chatId, messageId: assistantMsgId, scope }),
    })
    inflight.set(chatId, run.id)
    void runs.settled(run.id).finally(() => { inflight.delete(chatId) })

    if ((c.req.header('Accept') ?? '').includes('text/event-stream')) {
      return streamSSE(c, async (stream) => {
        const sub = runs.subscribe(run.id, 0)
        stream.onAbort(() => { sub.close() })   // dropping the stream must NOT abort the run
        await stream.writeSSE({
          event: 'run',
          data: JSON.stringify({ run_id: run.id, user_message_id: userMsgId, message_id: assistantMsgId, event_seq: 0 }),
        })
        for await (const ev of sub) {
          await stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) })
        }
      })
    }
    return c.json(toRunDTO(run), 202)
  })

  app.get(`${BASE}/runs`, requireScope('chats:read'), (c) =>
    c.json({ data: runs.list(c.get('extTenant') as string).map(toRunDTO) }))

  app.get(`${BASE}/runs/:id`, requireScope('chats:read'), (c) => {
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== c.get('extTenant')) return extError(c, 'not_found', 'not_found', 'Not found.')
    runs.touch(run.id)   // a poll is liveness (spec §6.5) — without this the reaper kills pollers
    return c.json(toRunDTO(run))
  })

  app.get(`${BASE}/runs/:id/stream`, requireScope('chats:read'), (c) => {
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== c.get('extTenant')) return extError(c, 'not_found', 'not_found', 'Not found.')
    const after = c.req.query('after') ? Number(c.req.query('after')) : 0
    if (!runs.canReplayFrom(run.id, after)) {
      return extError(c, 'conflict', 'replay_window_exceeded',
        'That cursor has aged out of the replay buffer. Re-read the message, then attach at the run current event_seq.')
    }
    return streamSSE(c, async (stream) => {
      const sub = runs.subscribe(run.id, after)
      stream.onAbort(() => { sub.close() })
      for await (const ev of sub) {
        await stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) })
      }
    })
  })

  app.post(`${BASE}/runs/:id/cancel`, requireScope('runs:write'), (c) => {
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== c.get('extTenant')) return extError(c, 'not_found', 'not_found', 'Not found.')
    const cancelled = runs.cancel(run.id)
    if (!cancelled) return extError(c, 'conflict', 'not_active', 'That run has already ended.')
    return c.json(toRunDTO(run))
  })
}
