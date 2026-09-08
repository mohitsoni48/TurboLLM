// Route-level coverage for the developer request log's HTTP surface (issue #211 follow-up):
// GET /api/v1/requests (list, filtered, bodies withheld by default), GET .../:id (single entry,
// bodies always included), GET .../stream (live SSE fan-out), DELETE (clear). The ring buffer
// itself is covered in observability/request-log.test.ts; gateway/chat capture sites in
// gateway.request-log.test.ts and chat-upstream.request-log.test.ts. This file only exercises
// routes.ts's wiring of `d.requestLog` to HTTP.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { RequestLog } from '../observability/request-log'
import type { Deps } from '../deps'

/** Reads SSE `event: ...` frames off a Response body — same helper shape as
 *  engine-log-stream.test.ts's, duplicated locally per that file's own stated convention
 *  (one small helper, not worth sharing across an api/ boundary). */
function sseEventReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  return {
    async next(timeoutMs = 3000): Promise<{ event: string; data: string }> {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const frameEnd = buf.indexOf('\n\n')
        if (frameEnd !== -1) {
          const frame = buf.slice(0, frameEnd)
          buf = buf.slice(frameEnd + 2)
          const event = frame.match(/^event: (.+)$/m)?.[1] ?? ''
          const data = frame.match(/^data: (.*)$/m)?.[1] ?? ''
          return { event, data }
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`sseEventReader.next: no frame within ${timeoutMs}ms`)
        const { done, value } = await reader.read()
        if (done) throw new Error('sseEventReader.next: stream ended before a frame arrived')
        buf += dec.decode(value, { stream: true })
      }
    },
  }
}

function fakeApp(requestLog: RequestLog | undefined) {
  const d = {
    version: 'test',
    store: { snapshot: () => ({}), update: (fn: (c: unknown) => void) => fn({}) },
    manager: { status: () => ({ state: 'stopped', model: null }), logPath: () => '' },
    requestLog,
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, d }
}

function seed(log: RequestLog): { okId: string; errId: string } {
  const okId = log.start({
    source: 'openai', harness: 'claude_code', codeSessionId: null, modelKey: 'qwen3-8b',
    remote: null, stream: false, params: { temperature: 0.7 }, counts: { messages: 1, tools: 0, systemChars: 0 },
    requestBody: '{"messages":[{"role":"user","content":"hi"}]}',
  })
  log.finalize(okId, { status: 200, promptTokens: 10, completionTokens: 5, responseBody: '{"content":"hello"}' })
  const errId = log.start({
    source: 'anthropic', harness: null, codeSessionId: null, modelKey: 'other-model',
    remote: null, stream: false, params: {}, counts: { messages: 1, tools: 0, systemChars: 0 },
  })
  log.finalize(errId, { status: 500, error: { code: 'engine_error', message: 'boom' } })
  return { okId, errId }
}

test('GET /api/v1/requests: lists entries, bodies withheld by default', async () => {
  const log = new RequestLog()
  seed(log)
  const { app } = fakeApp(log)
  const res = await app.request('/api/v1/requests')
  assert.equal(res.status, 200)
  const { entries } = (await res.json()) as { entries: Array<Record<string, unknown>> }
  assert.equal(entries.length, 2)
  for (const e of entries) assert.equal(e.bodies, null)
})

test('GET /api/v1/requests?bodies=1: includes captured bodies', async () => {
  const log = new RequestLog()
  seed(log)
  const { app } = fakeApp(log)
  const res = await app.request('/api/v1/requests?bodies=1')
  const { entries } = (await res.json()) as { entries: Array<{ bodies: { request: string; response: string } | null }> }
  const withBody = entries.find((e) => e.bodies !== null)!
  assert.match(withBody.bodies!.request, /"hi"/)
  assert.match(withBody.bodies!.response, /"hello"/)
})

test('GET /api/v1/requests: filters by source, status, and model', async () => {
  const log = new RequestLog()
  seed(log)
  const { app } = fakeApp(log)

  const bySource = await app.request('/api/v1/requests?source=anthropic')
  const { entries: sourceEntries } = (await bySource.json()) as { entries: Array<{ source: string }> }
  assert.equal(sourceEntries.length, 1)
  assert.equal(sourceEntries[0].source, 'anthropic')

  const byStatus = await app.request('/api/v1/requests?status=error')
  const { entries: statusEntries } = (await byStatus.json()) as { entries: Array<{ status: number }> }
  assert.equal(statusEntries.length, 1)
  assert.equal(statusEntries[0].status, 500)

  const byModel = await app.request('/api/v1/requests?model=qwen3-8b')
  const { entries: modelEntries } = (await byModel.json()) as { entries: Array<{ modelKey: string }> }
  assert.equal(modelEntries.length, 1)
  assert.equal(modelEntries[0].modelKey, 'qwen3-8b')
})

test('GET /api/v1/requests/:id: returns the single entry WITH bodies, regardless of ?bodies', async () => {
  const log = new RequestLog()
  const { okId } = seed(log)
  const { app } = fakeApp(log)
  const res = await app.request(`/api/v1/requests/${okId}`)
  assert.equal(res.status, 200)
  const { entry } = (await res.json()) as { entry: { id: string; bodies: { request: string; response: string } } }
  assert.equal(entry.id, okId)
  assert.match(entry.bodies.response, /"hello"/)
})

test('GET /api/v1/requests/:id: 404 for an unknown id', async () => {
  const log = new RequestLog()
  const { app } = fakeApp(log)
  const res = await app.request('/api/v1/requests/does-not-exist')
  assert.equal(res.status, 404)
})

test('DELETE /api/v1/requests: clears the log', async () => {
  const log = new RequestLog()
  seed(log)
  const { app } = fakeApp(log)
  const del = await app.request('/api/v1/requests', { method: 'DELETE' })
  assert.equal(del.status, 200)
  const after = await app.request('/api/v1/requests')
  const { entries } = (await after.json()) as { entries: unknown[] }
  assert.equal(entries.length, 0)
})

test('GET /api/v1/requests/stream: a subscriber receives entries as they are start()ed and finalize()d', async () => {
  const log = new RequestLog()
  const { app } = fakeApp(log)
  const res = await app.request('/api/v1/requests/stream')
  assert.ok(res.body)
  const events = sseEventReader(res.body!)

  const id = log.start({
    source: 'chat', harness: null, codeSessionId: null, modelKey: 'm',
    remote: null, stream: false, params: {}, counts: { messages: 0, tools: 0, systemChars: 0 },
  })
  const started = await events.next()
  assert.equal(started.event, 'entry')
  assert.equal(JSON.parse(started.data).id, id)
  assert.equal(JSON.parse(started.data).status, null)

  log.finalize(id, { status: 200, promptTokens: 1, completionTokens: 1 })
  const finalized = await events.next()
  assert.equal(finalized.event, 'entry')
  assert.equal(JSON.parse(finalized.data).status, 200)
})

test('every route degrades gracefully when d.requestLog is absent (feature not wired under some embeddings)', async () => {
  const { app } = fakeApp(undefined)
  const list = await app.request('/api/v1/requests')
  assert.equal(list.status, 200)
  assert.deepEqual(await list.json(), { entries: [] })

  const detail = await app.request('/api/v1/requests/anything')
  assert.equal(detail.status, 404)

  const del = await app.request('/api/v1/requests', { method: 'DELETE' })
  assert.equal(del.status, 200)
})
