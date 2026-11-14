import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFetchUrl, FETCH_URL_PDF_MAX_BYTES } from './builtin'
import { extractPdfText, isPdfResponse, PDF_MAX_PAGES } from './pdf-text'
import { dummyPdf } from '../test-support/dummy-pdf'
import { stubFetch } from '../test-support/fetch-stub'

// GitHub #52 (PDF-in-web-fetching): a PDF body used to be UTF-8-decoded like a text page,
// which handed the model raw PDF syntax garbage. The bytes now go through pdfjs-dist's
// legacy build (which loads the @napi-rs/canvas native addon at import under Node) and the
// page's text layer comes back. Reading is opt-in (tools.pdfReading), so tests that expect text pass PDF_ON.


const PDF_HEADERS = { 'content-type': 'application/pdf' }
const PDF_ON = { pdfReading: true }
const HANG_WORKER = new URL('./fetch-url-pdf-hang-worker.fixture.mjs', import.meta.url)
const UNAVAILABLE_WORKER = new URL('./fetch-url-pdf-unavailable-worker.fixture.mjs', import.meta.url)

test('isPdfResponse: the header says PDF', () => {
  assert.equal(isPdfResponse('application/pdf', 'http://files.invalid/doc'), true)
  assert.equal(isPdfResponse('application/pdf; charset=binary', 'http://files.invalid/doc'), true)
})

test('isPdfResponse: a generic content type with a .pdf path still counts', () => {
  assert.equal(isPdfResponse('application/octet-stream', 'http://files.invalid/Spec%20Draft.PDF'), true)
  assert.equal(isPdfResponse('', 'http://files.invalid/spec.pdf'), true)
})

test('isPdfResponse: a real content type overrides a .pdf-looking path', () => {
  // A viewer page ending in .pdf served as HTML must stay on the HTML path.
  assert.equal(isPdfResponse('text/html', 'http://files.invalid/view.pdf'), false)
  assert.equal(isPdfResponse('text/plain', 'http://files.invalid/notes.pdf'), false)
})

test('extractPdfText: reads the text layer of a real PDF, off the main thread', async () => {
  const outcome = await extractPdfText(new Uint8Array(dummyPdf))
  assert.equal(outcome.kind, 'text')
  if (outcome.kind === 'text') assert.match(outcome.text, /Dummy PDF file/)
})

test('extractPdfText: garbage bytes report unreadable, never a throw', async () => {
  assert.deepEqual(await extractPdfText(new Uint8Array([1, 2, 3, 4])), { kind: 'unreadable' })
  assert.deepEqual(await extractPdfText(new Uint8Array(0)), { kind: 'unreadable' })
})

// A near-zero watchdog budget fires before even a tiny real PDF can come back, exercising
// the actual timeout machinery: worker terminated, slot released, 'timeout' reported, the
// daemon's own thread never blocked on the parse.
test('extractPdfText: the watchdog terminates a parse that runs over budget', async () => {
  const t0 = Date.now()
  // A worker that never answers: the outcome cannot depend on how fast a real parse is.
  const outcome = await extractPdfText(new Uint8Array(dummyPdf), { timeoutMs: 50, workerPath: HANG_WORKER })
  assert.deepEqual(outcome, { kind: 'timeout' })
  assert.ok(Date.now() - t0 < 15_000, 'watchdog must end the wait promptly')
  // The slot was released: a following parse proceeds normally.
  const after = await extractPdfText(new Uint8Array(dummyPdf))
  assert.equal(after.kind, 'text')
})

test('extractPdfText: a reader that cannot load reports unavailable, not an unreadable document', async () => {
  const outcome = await extractPdfText(new Uint8Array(dummyPdf), { workerPath: UNAVAILABLE_WORKER })
  assert.deepEqual(outcome, { kind: 'unavailable' })
})

test('extractPdfText: the bytes are transferred, and a pooled Buffer slice is copied rather than detached', async () => {
  const owned = new Uint8Array(dummyPdf)
  const outcome = await extractPdfText(owned)
  assert.equal(outcome.kind, 'text')
  assert.equal(owned.byteLength, 0, 'an owning view is transferred to the worker, not cloned')
  // A Buffer from the shared pool is a view into memory other code uses: it must stay intact.
  const pool = new Uint8Array(dummyPdf.length + 16)
  pool.set(dummyPdf, 8)
  const view = pool.subarray(8, 8 + dummyPdf.length)
  assert.equal((await extractPdfText(view)).kind, 'text')
  assert.equal(pool.byteLength, dummyPdf.length + 16, 'the shared buffer was not detached')
})

test('execFetchUrl: a PDF reply comes back as its text, not binary garbage', async () => {
  const stub = stubFetch(() => new Response(dummyPdf, { headers: PDF_HEADERS }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/dummy.pdf' }, PDF_ON)
    assert.match(out, /Dummy PDF file/)
    assert.match(out, /^Published: unknown \| Retrieved: /)
    assert.doesNotMatch(out, /%PDF-1/)
  } finally { stub.restore() }
})

test('execFetchUrl: octet-stream with a .pdf path is parsed as a PDF', async () => {
  const stub = stubFetch(() => new Response(dummyPdf, { headers: { 'content-type': 'application/octet-stream' } }))
  try {
    assert.match(await execFetchUrl({ url: 'http://files.invalid/dummy.pdf' }, PDF_ON), /Dummy PDF file/)
  } finally { stub.restore() }
})

test('execFetchUrl: an HTML page at a .pdf URL stays on the HTML path', async () => {
  const stub = stubFetch(() => new Response('<html><body><p>viewer page</p></body></html>', { headers: { 'content-type': 'text/html' } }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/view.pdf' }, PDF_ON)
    assert.match(out, /viewer page/)
    assert.doesNotMatch(out, /no readable text layer/)
  } finally { stub.restore() }
})

test('execFetchUrl: an unparseable PDF says so in static text', async () => {
  const stub = stubFetch(() => new Response(Buffer.from('not a pdf at all'), { headers: PDF_HEADERS }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/broken.pdf' }, PDF_ON)
    assert.match(out, /no readable text layer/)
    assert.doesNotMatch(out, /not a pdf at all/)
  } finally { stub.restore() }
})

test('execFetchUrl: a PDF over the byte cap is reported too large, not half-parsed', async () => {
  const big = Buffer.alloc(FETCH_URL_PDF_MAX_BYTES + 1, 0x25)
  const stub = stubFetch(() => new Response(big, { headers: PDF_HEADERS }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/huge.pdf' }, PDF_ON)
    assert.match(out, /larger than the 10 MB fetch limit/)
  } finally { stub.restore() }
})

test('execFetchUrl: a plain-text page is untouched by the PDF path', async () => {
  const stub = stubFetch(() => new Response('plain hello', { headers: { 'content-type': 'text/plain' } }))
  try {
    assert.match(await execFetchUrl({ url: 'http://files.invalid/notes.txt' }, PDF_ON), /plain hello/)
  } finally { stub.restore() }
})

test('PDF_MAX_PAGES is a small sane bound', () => {
  assert.ok(PDF_MAX_PAGES > 0 && PDF_MAX_PAGES <= 100)
})

test('extractPdfText: at most 2 parses run at once; a timed-out parse frees its slot for the queue', async () => {
  // Two never-answering workers fill both slots; only the watchdog can end them.
  let slowSettled = 0
  const slow = [
    extractPdfText(new Uint8Array(dummyPdf), { timeoutMs: 200, workerPath: HANG_WORKER }),
    extractPdfText(new Uint8Array(dummyPdf), { timeoutMs: 200, workerPath: HANG_WORKER }),
  ].map((p) => p.then((o) => { slowSettled++; return o }))
  // The third parse must queue behind them: if the slot cap worked, it cannot have run before
  // at least one wedged worker was terminated and released. Real parse here, so slowSettled is
  // checked against the wedged workers' own deterministic 200 ms budget, not a parse duration.
  const third = await extractPdfText(new Uint8Array(dummyPdf))
  assert.equal(third.kind, 'text')
  assert.ok(slowSettled >= 1, 'the queued parse ran only after a wedged worker freed its slot')
  const [a, b] = await Promise.all(slow)
  assert.deepEqual([a.kind, b.kind], ['timeout', 'timeout'])
})

test('the parse itself touches no network: pdfjs gets bytes in process, fetch is never called', async () => {
  const { parsePdfText } = await import('./pdf-text-extract')
  let fetchCalls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error('network is off-limits inside the PDF parser')
  }) as typeof fetch
  try {
    const text = await parsePdfText(new Uint8Array(dummyPdf))
    assert.match(text ?? '', /Dummy PDF file/)
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('execFetchUrl: a PDF download that fails mid-stream is reported honestly, never parsed as a zero-padded forgery', async () => {
  // One real chunk, then the stream dies. The old shape allocated `read` bytes anyway and
  // handed the parser a zero-padded buffer that could "parse" misleadingly.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(dummyPdf.subarray(0, 100))
      controller.error(new Error('connection reset'))
    },
  })
  const stub = stubFetch(() => new Response(body, { headers: PDF_HEADERS }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/truncated.pdf' }, PDF_ON)
    assert.match(out, /could not be downloaded completely/)
    assert.doesNotMatch(out, /no readable text layer/)
    assert.doesNotMatch(out, /Dummy PDF file/)
  } finally { stub.restore() }
})

test('extractPdfText: a parse queued too long behind busy workers gives up honestly instead of waiting unbounded', async () => {
  // Hang workers hold both slots for 1.5 s, far longer than the 100 ms queue bound, so the
  // outcome never depends on how long a real one-page parse takes.
  const slow = [
    extractPdfText(new Uint8Array(dummyPdf), { timeoutMs: 1_500, workerPath: HANG_WORKER }),
    extractPdfText(new Uint8Array(dummyPdf), { timeoutMs: 1_500, workerPath: HANG_WORKER }),
  ]
  const t0 = Date.now()
  const queued = await extractPdfText(new Uint8Array(dummyPdf), { queueTimeoutMs: 100 })
  assert.deepEqual(queued, { kind: 'busy' })
  assert.ok(Date.now() - t0 < 1_000, 'the queue bound must end the wait promptly')
  // The lapsed waiter is gone: once the wedged workers time out, the next parse proceeds.
  const [a, b] = await Promise.all(slow)
  assert.deepEqual([a.kind, b.kind], ['timeout', 'timeout'])
  assert.equal((await extractPdfText(new Uint8Array(dummyPdf))).kind, 'text')
})

test('execFetchUrl: a PDF mislabeled text/plain at a non-.pdf URL is caught by its magic bytes', async () => {
  // Static hosts get content types wrong; the header check alone feeds the model raw PDF
  // syntax - the exact #52 complaint. The first-bytes sniff catches it.
  const stub = stubFetch(() => new Response(dummyPdf, { headers: { 'content-type': 'text/plain' } }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/download' }, PDF_ON)
    assert.match(out, /Dummy PDF file/)
    assert.doesNotMatch(out, /%PDF-1/)
  } finally { stub.restore() }
})

test('execFetchUrl: an HTML page mentioning %PDF- as text stays on the HTML path', async () => {
  const stub = stubFetch(() => new Response('<html><body><p>files start with %PDF- magic</p></body></html>', { headers: { 'content-type': 'text/html' } }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/about' }, PDF_ON)
    assert.match(out, /files start with %PDF- magic/)
    assert.doesNotMatch(out, /no readable text layer/)
  } finally { stub.restore() }
})

test('the host and worker side agree on the page bound (they cannot share an import)', async () => {
  // pdf-text-extract.ts must stay free of static relative imports (the spawned worker cannot
  // rely on tsx's loader hook), so the page cap is declared on both sides by design - this
  // test is the drift tripwire.
  const { PDF_MAX_PAGES: workerSide } = await import('./pdf-text-extract')
  assert.equal(PDF_MAX_PAGES, workerSide)
})

test('execFetchUrl: a PDF whose %PDF- signature arrives split across chunks is still caught', async () => {
  const part1 = dummyPdf.subarray(0, 3) // "%PD"
  const part2 = dummyPdf.subarray(3)
  const body = new ReadableStream({
    start(controller) { controller.enqueue(part1); controller.enqueue(part2); controller.close() },
  })
  const stub = stubFetch(() => new Response(body, { headers: { 'content-type': 'text/plain' } }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/download' }, PDF_ON)
    assert.match(out, /Dummy PDF file/)
    assert.doesNotMatch(out, /%PDF-1/)
  } finally { stub.restore() }
})

test('execFetchUrl: a plain-text file that merely starts with %PDF- gets the static note, never a raw-byte leak', async () => {
  const stub = stubFetch(() => new Response(Buffer.from('%PDF-hello this is just text'), { headers: { 'content-type': 'text/plain' } }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/notes' }, PDF_ON)
    assert.match(out, /no readable text layer/)
    assert.doesNotMatch(out, /hello this is just text/)
  } finally { stub.restore() }
})

test('execFetchUrl: with PDF reading off (the default) a PDF gets the fixed disabled note and is never parsed or decoded', async () => {
  for (const opts of [undefined, { pdfReading: false }]) {
    const stub = stubFetch(() => new Response(dummyPdf, { headers: PDF_HEADERS }))
    try {
      const out = await execFetchUrl({ url: 'http://files.invalid/dummy.pdf' }, opts)
      assert.match(out, /PDF reading is disabled/)
      assert.doesNotMatch(out, /Dummy PDF file/)
      assert.doesNotMatch(out, /%PDF-|obj|endobj/)
    } finally { stub.restore() }
  }
})

test('execFetchUrl: a mislabeled PDF (magic bytes) with reading off also gets the disabled note, not raw bytes', async () => {
  const stub = stubFetch(() => new Response(dummyPdf, { headers: { 'content-type': 'text/plain' } }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/download' })
    assert.match(out, /PDF reading is disabled/)
    assert.doesNotMatch(out, /%PDF-/)
  } finally { stub.restore() }
})

test('execFetchUrl: a PDF is recognised by the URL that answered after redirects, not the requested one', async () => {
  const stub = stubFetch(() => {
    const r = new Response(dummyPdf, { headers: { 'content-type': 'application/octet-stream' } })
    Object.defineProperty(r, 'url', { value: 'http://files.invalid/final.pdf' })
    return r
  })
  try {
    assert.match(await execFetchUrl({ url: 'http://files.invalid/get?id=7' }, PDF_ON), /Dummy PDF file/)
  } finally { stub.restore() }
  const page = stubFetch(() => {
    const r = new Response('<html><body><p>an ordinary page</p></body></html>', { headers: { 'content-type': 'application/octet-stream' } })
    Object.defineProperty(r, 'url', { value: 'http://files.invalid/landing' })
    return r
  })
  try {
    // Requested URL ends in .pdf but the reply that answered is a page: not parsed as a PDF.
    assert.match(await execFetchUrl({ url: 'http://files.invalid/old.pdf' }, PDF_ON), /an ordinary page/)
  } finally { page.restore() }
})

test('execFetchUrl: a PDF reply with no body says so, not "could not be downloaded completely"', async () => {
  const stub = stubFetch(() => new Response(null, { status: 200, headers: PDF_HEADERS }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/empty.pdf' }, PDF_ON)
    assert.match(out, /sent no content/)
    assert.doesNotMatch(out, /downloaded completely/)
  } finally { stub.restore() }
})

test('execFetchUrl: a PDF body gets its own, longer budget than the 15 s headers budget', async () => {
  // Headers budget 50 ms, PDF body budget 2 s: the body arrives after 300 ms (> the headers
  // budget) and must still be read. A non-PDF body arriving at the same pace is cut by 50 ms.
  const slowBody = (type: string, payload: Uint8Array | string) => () => {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
    const body = new ReadableStream<Uint8Array>({
      async start(c) { c.enqueue(bytes.slice(0, 8)); await new Promise((r) => setTimeout(r, 300)); c.enqueue(bytes.slice(8)); c.close() },
    })
    return new Response(body, { headers: { 'content-type': type } })
  }
  const pdf = stubFetch(slowBody('application/pdf', new Uint8Array(dummyPdf)))
  try {
    assert.match(await execFetchUrl({ url: 'http://files.invalid/slow.pdf' }, { pdfReading: true, headersTimeoutMs: 50, pdfBodyTimeoutMs: 2_000 }), /Dummy PDF file/)
  } finally { pdf.restore() }
})

test('execFetchUrl: a slow PDF body over its own budget is cut', async () => {
  // Same pace as the test above (300 ms between chunks) but only a 50 ms PDF body budget:
  // the read fails mid-stream and the answer is the incomplete-download note, not parsed text.
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      try {
        c.enqueue(new Uint8Array(dummyPdf).subarray(0, 8))
        await new Promise((r) => setTimeout(r, 300))
        if (c.desiredSize === null) return
        c.enqueue(new Uint8Array(dummyPdf).subarray(8))
        c.close()
      } catch { /* cancelled mid-wait */ }
    },
  })
  const stub = stubFetch(() => new Response(body, { headers: PDF_HEADERS }))
  try {
    assert.match(
      await execFetchUrl({ url: 'http://files.invalid/slow.pdf' }, { pdfReading: true, headersTimeoutMs: 50, pdfBodyTimeoutMs: 50 }),
      /could not be downloaded completely/,
    )
  } finally { stub.restore() }
})

test('execFetchUrl: a slow non-PDF body gets no extra budget and is cut by the headers budget', async () => {
  // An HTML page arriving at the same 300 ms pace: only the 50 ms headers budget applies, so
  // the late chunk never reaches the reply.
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      try {
        c.enqueue(enc.encode('<html><body>page-start'))
        await new Promise((r) => setTimeout(r, 300))
        if (c.desiredSize === null) return
        c.enqueue(enc.encode('late-html-chunk</body></html>'))
        c.close()
      } catch { /* cancelled mid-wait */ }
    },
  })
  const stub = stubFetch(() => new Response(body, { headers: { 'content-type': 'text/html' } }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/slow-page' }, { headersTimeoutMs: 50 })
    assert.doesNotMatch(out, /late-html-chunk/)
    assert.doesNotMatch(out, /page-start/)
  } finally { stub.restore() }
})

test('execFetchUrl: a PDF reply with no body and reading off says disabled, not no-content', async () => {
  const stub = stubFetch(() => new Response(null, { status: 200, headers: PDF_HEADERS }))
  try {
    const out = await execFetchUrl({ url: 'http://files.invalid/empty.pdf' }, {})
    assert.match(out, /PDF reading is disabled/)
    assert.doesNotMatch(out, /sent no content/)
  } finally { stub.restore() }
})
