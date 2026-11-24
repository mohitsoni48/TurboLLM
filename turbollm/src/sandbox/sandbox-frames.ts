// The pipe protocol between the daemon and the sandbox host (sandbox-host.mjs, GitHub #52): a 4-byte big-endian
// header length, the header as UTF-8 JSON, then the header's `size` raw bytes. Not plain JSON lines: a file inside a
// JSON string costs base64 and runs into V8's string limit long before the file limits do.
//
// The reading side here is the daemon's, and the host is hostile: sandboxed code that escapes into JS can write
// anything to Deno's stdout. So every frame is checked before a byte of its payload is kept: a header over its
// limit, one that is not a JSON object, or a `size` that is not a whole number within its limit is a violation, and
// the caller kills the process on it. Nothing a frame says is believed beyond those checks (sandbox-process.ts checks
// each frame's fields).

/** The largest header the daemon reads from the host. A result header lists at most 20 files by name. */
export const MAX_HOST_HEADER = 64 * 1024

export class FrameViolation extends Error {}

export interface Frame {
  header: Record<string, unknown> & { size: number }
  payload: Buffer
}

/** One frame's bytes: the length prefix, the header (its `size` set from the payload) and the payload. */
export function encodeFrame(header: Record<string, unknown>, payload: Buffer[] = []): Buffer {
  const size = payload.reduce((s, p) => s + p.length, 0)
  const h = Buffer.from(JSON.stringify({ ...header, size }), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(h.length, 0)
  return Buffer.concat([len, h, ...payload])
}

/** Splits a byte stream into frames. Chunks are kept as they arrive and joined once per frame part, so a large
 *  payload is copied once. Throws FrameViolation on the first bad frame; after that it must not be fed again. */
export class FrameReader {
  private chunks: Buffer[] = []
  private have = 0
  private header: Frame['header'] | null = null

  constructor(private readonly maxPayload: number, private readonly maxHeader = MAX_HOST_HEADER) {}

  push(chunk: Buffer): Frame[] {
    this.chunks.push(chunk)
    this.have += chunk.length
    const out: Frame[] = []
    for (;;) {
      if (!this.header) {
        if (this.have < 4) break
        const hlen = this.peek(4).readUInt32BE(0)
        if (hlen === 0 || hlen > this.maxHeader) throw new FrameViolation(`header of ${hlen} bytes`)
        if (this.have < 4 + hlen) break
        this.take(4)
        this.header = parseHeader(this.take(hlen), this.maxPayload)
      }
      if (this.have < this.header.size) break
      out.push({ header: this.header, payload: this.take(this.header.size) })
      this.header = null
    }
    return out
  }

  private peek(n: number): Buffer {
    return this.chunks[0].length >= n ? this.chunks[0].subarray(0, n) : Buffer.concat(this.chunks).subarray(0, n)
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n)
    let filled = 0
    while (filled < n) {
      const c = this.chunks[0]
      const k = Math.min(c.length, n - filled)
      c.copy(out, filled, 0, k)
      filled += k
      if (k === c.length) this.chunks.shift()
      else this.chunks[0] = c.subarray(k)
    }
    this.have -= n
    return out
  }
}

function parseHeader(bytes: Buffer, maxPayload: number): Frame['header'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new FrameViolation('header is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new FrameViolation('header is not an object')
  const size = (parsed as { size?: unknown }).size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > maxPayload) throw new FrameViolation(`payload size ${String(size)}`)
  return parsed as Frame['header']
}
