// GET /api/v1/attachments/:id serves a file run_python made for download (GitHub #52) only as a download: under the
// cleaned `?name=` with the file's own extension, sandboxed and never sniffed, so no CSV or JSON the code wrote can
// run as a page on the daemon's origin. An image or clip is served as before.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerChatRoutes } from './chat-routes.js'
import { ChatRuns } from './chat-runs.js'
import { ChatTurns } from './chat-turns.js'
import { attachmentRefId } from './attachments.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

function harness() {
  const dir = tmpDir('tllm-chat-attachment-download-')
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
  }
  const d = {
    chatTurns: new ChatTurns(), chatRuns: new ChatRuns(),
    db: store,
    store: { snapshot: () => cfg, read: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => dir },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  return { app, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const BODY = '{"html":"<script>alert(1)</script>"}'

test('a download is served as an attachment under its cleaned name, sandboxed and not sniffed', async () => {
  const h = harness()
  try {
    const id = attachmentRefId((await h.store.attachments.saveFile(Buffer.from(BODY), 'json'))!)!
    const cases: Array<[string, string]> = [
      ['', 'attachment; filename="file.json"; filename*=UTF-8\'\'file.json'],
      ['?name=result.json', 'attachment; filename="result.json"; filename*=UTF-8\'\'result.json'],
      ['?name=..%2F..%2Fpage.html', 'attachment; filename="page.html.json"; filename*=UTF-8\'\'page.html.json'],
      ['?name=a%0D%0ASet-Cookie%3A%20x', 'attachment; filename="a__Set-Cookie_ x.json"; filename*=UTF-8\'\'a__Set-Cookie_%20x.json'],
      ['?name=r%C3%A9sum%C3%A9%20(1).json', 'attachment; filename="r_sum_ (1).json"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%20%281%29.json'],
    ]
    for (const [query, disposition] of cases) {
      const res = await h.app.request(`/api/v1/attachments/${id}${query}`)
      assert.equal(res.status, 200, query)
      assert.equal(res.headers.get('content-disposition'), disposition, query)
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', query)
      assert.equal(res.headers.get('content-security-policy'), 'sandbox', query)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', query)
      assert.equal(await res.text(), BODY, query)
    }
  } finally {
    h.cleanup()
  }
})

test('an image is served as before: inline, with no download headers', async () => {
  const h = harness()
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const [ref] = await h.store.attachments.save([`data:image/png;base64,${png.toString('base64')}`])
    const res = await h.app.request(`/api/v1/attachments/${attachmentRefId(ref)}?name=x.html`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(res.headers.get('content-disposition'), null)
    assert.equal(res.headers.get('content-security-policy'), null)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  } finally {
    h.cleanup()
  }
})

test('an id the store does not write is not found', async () => {
  const h = harness()
  try {
    for (const id of [`${'a'.repeat(64)}.html`, `${'a'.repeat(64)}.csv`, '..%2Fturbollm.db']) {
      assert.equal((await h.app.request(`/api/v1/attachments/${id}`)).status, 404, id)
    }
  } finally {
    h.cleanup()
  }
})
