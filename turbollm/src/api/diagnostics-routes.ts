// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { readTail } from '../engines/engine-log'
import { createHash } from 'node:crypto'
import type { Deps } from '../deps'
import { stripBodies } from '../observability/request-log'
import { holdOpen, hostGate } from '../auth'
import type { LoadProfile } from '../models/profile'
import { BenchError } from '../bench/bench'
import { launchFieldsRefusal, loadsWithNow } from './profile-validate'
import { err, body, type Status } from './http'

/** Engine logs, the developer request log, and auto-benchmark/auto-tune. */
export function registerDiagnosticsRoutes(app: Hono, d: Deps): void {
  // ?model=<modelKey> picks a loaded pool slot's log (keep-N, embedding, Laya) instead of the primary's. The key is
  // matched against the router's live slots and never becomes a path, so only a slot's own log file can be read.
  // The slot may go before a stream's next tick; its log is then simply quiet (a path of ''), like a stopped primary.
  const engineLogSource = (c: Context): { path: () => string } | null => {
    const model = c.req.query('model')
    if (model === undefined || model === '') return { path: () => d.manager.logPath() }
    if (!d.modelRouter?.slotLogs().some((s) => s.modelKey === model)) return null
    return { path: () => d.modelRouter.slotLogs().find((s) => s.modelKey === model)?.logPath ?? '' }
  }

  app.get('/api/v1/engine/logs', (c) => {
    const tail = Math.min(Number(c.req.query('tail')) || 200, 2000)
    const source = engineLogSource(c)
    if (!source) return err(c, 404, 'slot_not_found', 'No loaded model by that key has an engine log.')
    // slots: the models whose logs ?model= can pick, so the UI offers a selector only when there are some.
    return c.json({ lines: readTail(source.path(), tail), slots: (d.modelRouter?.slotLogs() ?? []).map((s) => s.modelKey) })
  })

  app.get('/api/v1/engine/logs/stream', (c) => {
    const source = engineLogSource(c)
    if (!source) return err(c, 404, 'slot_not_found', 'No loaded model by that key has an engine log.')
    const logPath = source.path
    // holdOpen: the key or the open LAN that let it in can go while it runs (see endStaleStreams).
    return streamSSE(c, holdOpen(c, async (stream) => {
      // `bytePos`/`lastPath` are this CONNECTION's own cursor. `manager.ts`'s engine start
      // TRUNCATES the log file (a restart rewrites the same path from empty) and `logPath()`
      // itself changes on an engine switch — either way the file can shrink below `bytePos`,
      // and unless the cursor is fixed the loop stalls forever: no error, no new lines, until
      // the new file eventually regrows past the old length. So "this is effectively a new log"
      // (different path, OR the same path now shorter than what's already been read, OR whose
      // bytes before the cursor are no longer the ones read there) restarts the cursor at 0 — the
      // new run's opening lines (build, GPU detection, GGUF metadata) are exactly what the user
      // needs, and the client never refetches the tail on a restart. Only a brand-new connection's
      // FIRST look starts at the file's CURRENT size: it starts from "now" instead of replaying
      // the whole history, which would otherwise race the client's own initial-tail GET (whichever
      // arrived first, the result was either duplicated or truncated lines). ADR-409's review,
      // PR #216.
      //
      // A RECONNECT is not brand-new: starting it from "now" lost every line written while the
      // client was away (a Wi-Fi drop, sleep/wake, the 3 s before a reopen). Each line and ping
      // carries the cursor just past it as its SSE id (logCursor), the client sends the last one
      // back as Last-Event-ID (web sse.ts subscribeSse, as EventSource does), and the first look
      // resumes there when it still names this log; one from another log (a restart or a switch
      // while away) starts this one from 0, as the loop does for a new log. A ping goes out on
      // the first tick too, so a quiet log's connection has a cursor before any line. A resume
      // replays at most the log's last LOG_RESUME_MAX_BYTES (resumeLogCursor), from the first
      // whole line in them (`dropPartial`): a cursor from hours ago (a laptop that slept with
      // Monitor open) or another log's would otherwise read the whole gap in one readSync and
      // send every line of it, though the client keeps only its last 2000.
      //
      // Perf follow-up (docs/TODO.md, "Verification & chores", ADR-409 review item 2): the
      // previous version did `readFileSync(path).split('\n')` — the WHOLE file, synchronously,
      // every 400ms tick, for as long as Monitor/Engines-drawer is open. Harmless on a short
      // log; on a long verbose session (tens of MB) it periodically blocked the daemon's event
      // loop, including `/v1/chat/completions`. Now reads only the byte DELTA since the last
      // tick via `readSync` at a tracked offset — a live-tailed log costs O(new bytes), not
      // O(whole file), per tick. A line not yet newline-terminated is held as raw bytes (`carry`)
      // and decoded only once complete, so a multi-byte UTF-8 character split across two ticks'
      // byte ranges decodes whole instead of as U+FFFD (a newline byte never occurs inside one),
      // and each line's end is an exact byte offset for its cursor.
      const resume = c.req.header('Last-Event-ID')
      let bytePos = 0
      let lastPath = ''
      let firstLook = true // this connection has not polled the log yet
      let carry: Buffer = Buffer.alloc(0) // a line seen but not yet newline-terminated, held for the next tick
      let before: Buffer = Buffer.alloc(0) // the bytes just before the cursor (bytePos - carry.length), for logCursor
      let dropPartial = false // a resume cut short by its floor starts mid-line: skip that line's tail
      let aborted = false
      let ticks = 0
      stream.onAbort(() => {
        aborted = true
      })
      while (!aborted) {
        const path = logPath()
        if (path && existsSync(path)) {
          const size = statSync(path).size
          // A restart rewrites the same path, and the next run's log can outgrow a short one (a
          // model that failed at once) before a tick sees it shorter: going by the size alone,
          // the loop then read the new log from the old offset, losing its header and opening
          // lines and sending a line's tail first. Bytes already read before the offset never
          // change in the same log, so ones that differ now mean a new log too. Checked only when
          // there is something new to read, so a quiet log's tick costs no extra read.
          if (path !== lastPath || size < bytePos || (size > bytePos && logRewritten(path, bytePos, before, carry))) {
            const resumed = firstLook && resume !== undefined ? resumeLogCursor(path, size, resume) : null
            if (resumed) {
              bytePos = resumed.at
              before = resumed.before
              dropPartial = resumed.midLine
            } else {
              bytePos = firstLook ? size : 0
              before = readLogBytes(path, bytePos)
              // A resume's cut line that had no newline yet (a long `\r` progress bar) belongs
              // to the old log: left set, the skip ate this new log's first line.
              dropPartial = false
            }
            lastPath = path
            carry = Buffer.alloc(0)
          }
          if (size > bytePos) {
            const len = size - bytePos
            const buf = Buffer.alloc(len)
            const fd = openSync(path, 'r')
            try {
              readSync(fd, buf, 0, len, bytePos)
            } finally {
              closeSync(fd)
            }
            const chunkStart = bytePos - carry.length
            const chunk = carry.length ? Buffer.concat([carry, buf]) : buf
            const beforeChunk = before
            bytePos = size
            let from = 0
            for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, from)) {
              const line = chunk.toString('utf8', from, nl).replace(/\r$/, '')
              from = nl + 1
              before = Buffer.from(
                from >= LOG_CURSOR_BYTES
                  ? chunk.subarray(from - LOG_CURSOR_BYTES, from)
                  : Buffer.concat([beforeChunk, chunk.subarray(0, from)]).subarray(-LOG_CURSOR_BYTES),
              )
              if (dropPartial) {
                dropPartial = false
                continue
              }
              await stream.writeSSE({ event: 'line', data: JSON.stringify({ line }), id: logCursor(path, chunkStart + from, before) })
            }
            carry = Buffer.from(chunk.subarray(from))
          }
        }
        // Set whether or not a log existed yet: one that appears later is a new run's, read from 0.
        firstLook = false
        if (ticks++ % 37 === 0) await stream.writeSSE({ data: '', event: 'ping', id: logCursor(lastPath, bytePos - carry.length, before) })
        await stream.sleep(400)
      }
    }))
  })

  // ---- Developer request log (issue #211 follow-up) ----
  // Every completion this daemon has proxied (external API clients, Code sessions, in-app
  // Chat) — LM Studio-style: params, timings, tokens, and (opt-in) full request/response
  // bodies. In-memory only (`RequestLog`, observability/request-log.ts); nothing here is ever
  // persisted or sent to telemetry. Same auth treatment as `/api/v1/engine/logs` above — no
  // per-route middleware, covered by the global `lanAuth` mounted in server.ts — except the
  // captured bodies, which carry hostGate (REQUEST_BODIES_HOST_ONLY): they hold Code sessions'
  // and `turbollm launch` agents' full prompts (files the agent read, `.env` included, and tool
  // output), which codeAuth keeps from a keyless Tailscale Serve identity, a verified Cloudflare
  // Access JWT and an open-LAN peer. lanAuth admits all three, so with capture on they read
  // every agent turn through `?bodies=1` and `/:id` while `/api/v1/code/*` refused them.
  //
  // `/stream` is registered BEFORE `/:id` so it can never be shadowed by the param route —
  // Hono resolves a literal segment over a param one regardless of registration order, but
  // ordering it this way keeps the intent obvious without relying on that.
  app.get('/api/v1/requests/stream', (c) =>
    // holdOpen: the key or the open LAN that let it in can go while it runs (see endStaleStreams).
    streamSSE(c, holdOpen(c, async (stream) => {
      if (!d.requestLog) return
      let aborted = false
      stream.onAbort(() => { aborted = true })
      const unsubscribe = d.requestLog.subscribe((entry) => {
        if (aborted) return
        // Bodies stripped like the list endpoint's: with body capture on, every request would
        // otherwise ship its full prompt (and again with the response on finalize) into a
        // 500-row browser buffer the daemon's own 32 MB body budget doesn't bound. The detail
        // drawer fetches bodies per entry (GET /requests/:id).
        void stream.writeSSE({ event: 'entry', data: JSON.stringify(stripBodies(entry)) })
      })
      let ticks = 0
      try {
        while (!aborted) {
          if (++ticks % 37 === 0) await stream.writeSSE({ data: '', event: 'ping' })
          await stream.sleep(400)
        }
      } finally {
        unsubscribe()
      }
    })),
  )

  app.get('/api/v1/requests', (c) => {
    if (!d.requestLog) return c.json({ entries: [] })
    const q = c.req.query()
    const limit = q.limit !== undefined ? Math.min(Math.max(Number(q.limit) || 0, 1), 2000) : undefined
    const since = q.since !== undefined ? Number(q.since) : undefined
    const source = q.source === 'openai' || q.source === 'anthropic' || q.source === 'chat' ? q.source : undefined
    const status = q.status === 'ok' || q.status === 'error' ? q.status : undefined
    // Bodies are withheld from the LIST endpoint unless explicitly requested — a row list
    // rendering hundreds of entries has no business pulling every captured prompt/response
    // over the wire just to show a time/status/tokens table.
    const bodies = q.bodies === '1' || q.bodies === 'true'
    if (bodies && !hostGate(c, d)) return err(c, 403, 'api_key_required', REQUEST_BODIES_HOST_ONLY)
    return c.json({ entries: d.requestLog.list({ limit, since, source, modelKey: q.model, status, bodies }) })
  })

  app.get('/api/v1/requests/:id', (c) => {
    if (!d.requestLog) return err(c, 404, 'not_found', 'No request log entry with that id.')
    const entry = d.requestLog.get(c.req.param('id'))
    if (!entry) return err(c, 404, 'not_found', 'No request log entry with that id.')
    // An entry without bodies is what the list already shows; on a refusal the detail drawer
    // shows the row's own copy and says a key is needed (REQUEST_BODIES_HOST_ONLY).
    if (entry.bodies && !hostGate(c, d)) return err(c, 403, 'api_key_required', REQUEST_BODIES_HOST_ONLY)
    return c.json({ entry })
  })

  app.delete('/api/v1/requests', (c) => {
    d.requestLog?.clear()
    return c.json({ ok: true })
  })

  // ---- auto-benchmark + auto-tune (M3, spec 09 §1) ----
  // Start a sweep for a model. 202 + poll /status `bench`. 409 when a run is already
  // active or the engine is busy (the UI offers "Stop & benchmark" to free it first).
  app.post('/api/v1/bench', async (c) => {
    const b = await body<{ modelKey?: string; base?: Partial<LoadProfile> }>(c)
    const key = (b.modelKey ?? '').trim()
    if (!key) return err(c, 400, 'invalid_config_value', 'modelKey is required.')
    // The base's flags and files go onto every candidate's command line and into the tune Save
    // keeps (and pins), so they are held to /engine/start's rule: the model's own, or a key.
    const launchRefused = launchFieldsRefusal(c, d, b.base, loadsWithNow(d, key, ''))
    if (launchRefused) return launchRefused
    // A sweep loads the model repeatedly — same GPU contention as a normal load.
    if (d.comfy?.isBlocked()) return err(c, 409, 'comfyui_busy', 'ComfyUI is rendering — benchmarking is paused until its queue finishes.')
    // Reverse gate (F-011): a sweep loads the model repeatedly, so free ComfyUI's VRAM
    // once before it begins — the sweep then owns the GPU. No-op unless the reverse gate
    // is enabled and ComfyUI is idle; non-fatal on failure (benchmarks anyway). It throws
    // only when a ComfyUI render is starting (an acquire in flight): the same 409 as above.
    try {
      await d.comfy?.freeComfyUIBeforeLoad()
    } catch {
      return err(c, 409, 'comfyui_busy', 'ComfyUI is rendering — benchmarking is paused until its queue finishes.')
    }
    try {
      // `base` is the user's current config (dialog draft): auto-tune fixes its ctx +
      // KV quant and sweeps only offload on top (spec 09 §1, honoring the user's config).
      d.bench.start(key, b.base && typeof b.base === 'object' ? b.base : undefined)
      return c.json({ accepted: true }, 202)
    } catch (e) {
      return benchError(c, e)
    }
  })

  // Cancel the active run: stops after the current step, leaves the engine stopped,
  // keeps the partial results (spec 09 AC#3). Always 200 (no-op when none running).
  // The user's own Cancel, from the auto-tune card during a run and from the results dialog after one, so it also
  // discards a finished run's unsaved result. The engine kill switches call bench.cancel() alone, which keeps it.
  app.post('/api/v1/bench/cancel', (c) => {
    d.bench.cancel()
    d.bench.discardResult()
    return c.json({ ok: true })
  })

  // Persist the finished auto-tune's winning profile (the user clicked Save in the results dialog).
  app.post('/api/v1/bench/save', (c) => {
    const saved = d.bench.saveResult()
    if (!saved) return err(c, 409, 'no_bench_result', 'No auto-tune result to save.')
    return c.json({ ok: true })
  })

  app.get('/api/v1/bench/log', (c) => {
    const log = d.bench.getLog()
    if (!log) return err(c, 404, 'no_bench_log', 'No auto-tune log available.')
    const slug = log.modelKey.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').slice(0, 60)
    c.header('Content-Disposition', `attachment; filename="autotune-${slug}-${log.startedAt.slice(0, 10)}.json"`)
    return c.json(log)
  })
}

/** The refusal for a caller failing hostGate that asks the request log for captured bodies —
 *  see the request log's route comment. Sent as 403 api_key_required, like the host-only
 *  settings' refusal, so the web client opens its key prompt (auth-signal.ts) and the detail
 *  drawer says a key is needed: as `forbidden` it fell back to the bodyless row and read "No
 *  body captured", and with requireApiKey off nothing else asks that browser for a key. */
const REQUEST_BODIES_HOST_ONLY = 'Captured prompts and responses can only be read on this machine or with a valid API key.'

function benchError(c: Context, e: unknown) {
  if (e instanceof BenchError) {
    const status: Status =
      e.code === 'bench_running' || e.code === 'engine_in_use' || e.code === 'no_active_engine' ? 409
        : e.code === 'no_such_model' ? 404
        : 400
    return err(c, status, e.code, e.message)
  }
  return err(c, 500, 'internal', (e as Error).message)
}

/** How many bytes before an engine-log cursor its fingerprint covers. */
const LOG_CURSOR_BYTES = 64

/** An engine-log position for GET /api/v1/engine/logs/stream's resume (its SSE ids): the byte
 *  offset read up to, and a hash of the log's path and the bytes just before that offset. The
 *  offset alone could land in another log: a restart rewrites the same path from empty and a
 *  switch changes it, and the new log can grow past the old offset while the client is away. */
function logCursor(path: string, end: number, before: Buffer): string {
  const hash = createHash('sha1').update(path).update('\0').update(before).digest('hex').slice(0, 16)
  return `${end}:${before.length}:${hash}`
}

/** Up to LOG_CURSOR_BYTES bytes of `path` ending at `end` (none when it can't be read). */
function readLogBytes(path: string, end: number, n = Math.min(end, LOG_CURSOR_BYTES)): Buffer {
  const out = Buffer.alloc(n)
  if (n === 0) return out
  try {
    const fd = openSync(path, 'r')
    try {
      return out.subarray(0, readSync(fd, out, 0, n, end - n))
    } finally {
      closeSync(fd)
    }
  } catch {
    return Buffer.alloc(0)
  }
}

/** Whether `path` no longer holds, just before `end`, the bytes a stream read there: its
 *  fingerprint `before` and then the line it carries (`carry`), at most LOG_CURSOR_BYTES of
 *  them. A read that fails or comes up short says nothing (a short one is a shrink, which the
 *  next tick sees). */
function logRewritten(path: string, end: number, before: Buffer, carry: Buffer): boolean {
  const held = carry.length >= LOG_CURSOR_BYTES ? carry.subarray(-LOG_CURSOR_BYTES) : Buffer.concat([before, carry]).subarray(-LOG_CURSOR_BYTES)
  if (held.length === 0) return false
  const now = readLogBytes(path, end, held.length)
  return now.length === held.length && !now.equals(held)
}

/** The most of an engine log a resumed stream replays: the client keeps its last 2000 lines
 *  (web use-engine-log.ts MAX_LINES), and a log line is rarely past 128 bytes. */
const LOG_RESUME_MAX_BYTES = 256 * 1024

/** Where a stream resumed with this Last-Event-ID starts reading `path` (now `size` bytes): the
 *  cursor's offset when it still names this log, else 0, the start of a log new to this client;
 *  either way no earlier than the last LOG_RESUME_MAX_BYTES, and `midLine` when that floor cuts
 *  a line, whose tail the stream skips. Null for an id that is not a logCursor at all, which is
 *  read as a fresh connection. */
function resumeLogCursor(path: string, size: number, cursor: string): { at: number; before: Buffer; midLine: boolean } | null {
  const m = /^(\d+):(\d+):[0-9a-f]{16}$/.exec(cursor)
  if (!m) return null
  const end = Number(m[1])
  const n = Number(m[2])
  let at = 0
  let before: Buffer = Buffer.alloc(0)
  if (end <= size && n <= Math.min(end, LOG_CURSOR_BYTES)) {
    const bytes = readLogBytes(path, end, n)
    if (logCursor(path, end, bytes) === cursor) {
      at = end
      before = bytes
    }
  }
  const floor = size - LOG_RESUME_MAX_BYTES
  if (at >= floor) return { at, before, midLine: false }
  before = readLogBytes(path, floor)
  return { at: floor, before, midLine: before.length > 0 && before[before.length - 1] !== 0x0a }
}
