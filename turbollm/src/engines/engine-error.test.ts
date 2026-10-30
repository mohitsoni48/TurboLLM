// An engine's reason for refusing or failing a request, for the chat, the extension API and routines to report.
// Upstream's `litert-lm serve` gives it in the HTTP status line, with an HTML error page for a body (into which, for a
// client lenient enough to read the reply at all, the page's own headers fall when the reason ends with a newline),
// which no path read; and the extension API and routines read no reason at all.
import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'
import { test } from 'node:test'
import { engineErrorReason } from './engine-error'

const res = (body: string | null, status: number, statusText = '') => new Response(body, { status, statusText })

test('engineErrorReason: the body\'s error in each engine\'s shape, else its text', async () => {
  assert.equal(await engineErrorReason(res(JSON.stringify({ error: { message: 'context full', code: 500 } }), 500)), 'context full')
  assert.equal(await engineErrorReason(res(JSON.stringify({ error: 'RuntimeError: boom' }), 500)), 'RuntimeError: boom')
  assert.equal(await engineErrorReason(res(JSON.stringify({ message: 'max_tokens too large' }), 400)), 'max_tokens too large')
  assert.equal(await engineErrorReason(res(JSON.stringify({ detail: 'Not Found' }), 404)), 'Not Found')
  assert.equal(await engineErrorReason(res('plain failure\n', 503)), 'plain failure')
  assert.equal((await engineErrorReason(res('x'.repeat(900), 500))).length, 500)
})

test('engineErrorReason: with no body, the status line\'s reason when it is the engine\'s own (LiteRT-LM), not HTTP\'s stock phrase', async () => {
  // A reason in the status line and no body (`litert-lm serve` sends an HTML page as well: the test below).
  assert.equal(
    await engineErrorReason(res(null, 400, 'Invalid sampler parameters: ValueError: top_k should be positive, but got 0.')),
    'Invalid sampler parameters: ValueError: top_k should be positive, but got 0.',
  )
  assert.equal(await engineErrorReason(res(null, 400, 'Bad Request')), '')
  assert.equal(await engineErrorReason(res(null, 500)), '')
})

/** Python's http.server error page (BaseHTTPRequestHandler.send_error), as `litert-lm serve` 0.18.0 sends it. */
const page = (code: number, message: string, explanation: string) =>
  '<!DOCTYPE HTML>\n<html lang="en">\n    <head>\n        <meta charset="utf-8">\n        <title>Error response</title>\n' +
  `    </head>\n    <body>\n        <h1>Error response</h1>\n        <p>Error code: ${code}</p>\n` +
  `        <p>Message: ${message}.</p>\n        <p>Error code explanation: ${code} - ${explanation}</p>\n    </body>\n</html>\n`
/** Those bytes on the wire: the status line ends with the reason as it is, newline included. */
const wire = (code: number, reason: string, body: string) =>
  `HTTP/1.0 ${code} ${reason}\r\nServer: BaseHTTP/0.6 Python/3.12.3\r\nDate: Sun, 25 Oct 2026 04:18:26 GMT\r\n` +
  `Connection: close\r\nContent-Type: text/html;charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`

test('engineErrorReason: `litert-lm serve`\'s error as it comes over HTTP, its HTML page and the headers that fall into it', async (t) => {
  // What `serve` 0.18.0 answered, byte for byte (but the Date): an LFM2 request; {"top_k": 0} to Qwen3-0.6B; a request
  // with no model, whose reason has no newline. And a page under a stock status phrase. Read by Node's built-in fetch,
  // which takes a status line cut short by the reason's newline; the daemon's own dispatcher refuses one.
  const answers = [
    wire(500, 'RuntimeError: Failed to create conversation\n', page(500, 'RuntimeError: Failed to create conversation\n', 'Server got itself in trouble.')),
    wire(400, 'Invalid sampler parameters: ValueError: top_k should be positive, but got 0.\n',
      page(400, 'Invalid sampler parameters: ValueError: top_k should be positive, but got 0.\n', 'Bad request syntax or unsupported method.')),
    wire(400, 'Missing model', page(400, 'Missing model', 'Bad request syntax or unsupported method.')),
    wire(404, 'Not Found', page(404, 'No model &lt;x&gt; here', 'Nothing matches the given URI.')),
  ]
  let next = 0
  const server = createServer((sock) => {
    const answer = answers[next++]
    sock.once('data', () => sock.end(answer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
  const ask = async () => engineErrorReason(await fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) }))
  assert.equal(await ask(), 'RuntimeError: Failed to create conversation')
  assert.equal(await ask(), 'Invalid sampler parameters: ValueError: top_k should be positive, but got 0.')
  assert.equal(await ask(), 'Missing model')
  assert.equal(await ask(), 'No model <x> here')
})
