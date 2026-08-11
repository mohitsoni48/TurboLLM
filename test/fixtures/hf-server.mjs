// Stands in for Hugging Face and the engine-asset host so the REAL download
// and provision code paths run end to end against tiny artifacts.
// FIXTURE_MODE selects an injected failure (spec 25 §10.3).
import { createServer } from 'node:http'

const mode = process.env.FIXTURE_MODE ?? 'happy'
// A genuinely valid (if empty) GGUF: magic "GGUF" + version 3 + tensor_count 0 +
// kv_count 0, little-endian, then zero padding. Found live, two separate gaps stacked
// on each other:
//  1. The previous buffer ("GGUF" + zero padding) put 0 in the VERSION field too, and
//     gguf.ts's parseGguf() rejects any version other than 2/3 — every scanned file
//     built from this fixture silently failed to parse.
//  2. scanner.ts's directory walk also requires `st.size >= 1 << 20` (1 MiB) before it
//     even attempts to parse a .gguf at all — the original 1024-byte body was two
//     orders of magnitude under that floor, unconditionally skipped regardless of (1).
// Together these meant "use a model I already have" against any fixture-downloaded
// file always showed an empty list — not a wizard bug, a fixture gap. Padding after the
// 24-byte header is inert either way — parseGguf() stops reading once kv_count's loop
// (0 iterations) is done — so the extra ~1 MiB is pure size-floor padding, not parsed.
const TINY_GGUF = Buffer.concat([
  Buffer.from('GGUF', 'ascii'),
  Buffer.from(new Uint32Array([3]).buffer), // version
  Buffer.alloc(8), // tensor_count = 0 (u64 LE)
  Buffer.alloc(8), // kv_count = 0 (u64 LE)
  Buffer.alloc(1 << 20), // clears scanner.ts's `st.size >= 1 << 20` floor
])

export function startFixture(port = 8080) {
  return createServer(async (req, res) => {
    if (mode === 'network') { res.destroy(); return }
    if (mode === 'no_asset') { res.writeHead(404).end('not found'); return }
    // Opt-in per-request artificial delay: a request path containing `/delay-<ms>ms/`
    // waits that long before responding at all, then serves the normal happy-path bytes.
    // Every other download in this suite resolves near-instantly, which structurally
    // cannot reproduce a download that is still genuinely in flight the moment a client
    // first mounts LoadStep and takes its first poll — exactly the real-world timing a
    // real onboarding run against real HuggingFace hit and got stuck on forever (a client
    // polling bug, not a fixture bug, but this fixture had no way to exercise it before).
    // Scoped to the request path, not FIXTURE_MODE, so it never affects any other test
    // sharing this same fixture server/container.
    const delayMatch = req.url.match(/\/delay-(\d+)ms\//)
    if (delayMatch) await new Promise((r) => setTimeout(r, Number(delayMatch[1])))
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
