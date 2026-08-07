// Stands in for Hugging Face and the engine-asset host so the REAL download
// and provision code paths run end to end against tiny artifacts.
// FIXTURE_MODE selects an injected failure (spec 25 §10.3).
import { createServer } from 'node:http'

const mode = process.env.FIXTURE_MODE ?? 'happy'
const TINY_GGUF = Buffer.from('GGUF' + '\0'.repeat(1020)) // parses as a header, loads as nothing

export function startFixture(port = 8080) {
  return createServer((req, res) => {
    if (mode === 'network') { res.destroy(); return }
    if (mode === 'no_asset') { res.writeHead(404).end('not found'); return }
    if (mode === 'bad_gguf') {
      // A truncated body: presents exactly like corruption, which is precisely
      // why classifyLoadFailure folds the two together.
      res.writeHead(200, { 'content-length': String(TINY_GGUF.length) })
      res.end(TINY_GGUF.subarray(0, 16))
      return
    }
    res.writeHead(200, { 'content-length': String(TINY_GGUF.length) })
    res.end(TINY_GGUF)
  }).listen(port, '127.0.0.1')
}
