import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { registerLinkApi } from './link-routes'
import { DownloadError, type DownloadRecord, type EnqueueInput } from '../downloads/downloads'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'
import { LinkClient } from './link-client'

/** Destination paths are deliberately WINDOWS-absolute and POSIX-absolute in the fixtures:
 *  every response this suite touches is asserted not to contain either. */
const WIN_DEST = 'D:\\models\\qwen3-35b\\qwen3-35b-Q4_K_M.gguf'
const POSIX_DEST = '/home/dev/models/gemma-27b/gemma-27b-Q4_K_M.gguf'

function rec(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'dl-1',
    name: 'qwen3-35b-Q4_K_M.gguf',
    repo: 'Qwen/Qwen3-35B-GGUF',
    url: 'https://huggingface.co/Qwen/Qwen3-35B-GGUF/resolve/main/qwen3-35b-Q4_K_M.gguf',
    dest: WIN_DEST,
    total: 1000,
    received: 250,
    status: 'downloading',
    error: null,
    bytesPerSec: 1024,
    sha256: 'abc123',
    createdAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

function key(raw: string, caps?: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never } } : {}),
  }
}

interface Harness {
  d: Deps
  /** Every `enqueue()` the façade caused, in order, with the input it was handed. */
  enqueued: EnqueueInput[]
  /** Every `remove()` the façade caused, in order, by id. */
  removed: string[]
}

function mkDeps(
  keys: ApiKey[],
  records: DownloadRecord[],
  opts?: { enqueueThrows?: unknown },
): Harness {
  const cfg: Record<string, unknown> = {
    apiKeys: keys,
    links: [],
    daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc' },
  }
  const enqueued: EnqueueInput[] = []
  const removed: string[] = []

  // A STUB manager: this suite must never touch the network or the filesystem. The real
  // DownloadManager would fetch from Hugging Face and write .part files.
  const downloads = {
    list: () => records,
    enqueue: async (input: EnqueueInput) => {
      enqueued.push(input)
      if (opts?.enqueueThrows) throw opts.enqueueThrows
      return [rec({ id: 'dl-new', status: 'queued', received: 0, dest: POSIX_DEST })]
    },
    remove: (id: string) => {
      removed.push(id)
      return records.some((r) => r.id === id)
    },
    activeCount: () => records.filter((r) => r.status === 'downloading').length,
  }

  const store = { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) }
  const d = { version: '1.11.2', store, downloads } as unknown as Deps
  return { d, enqueued, removed }
}

function app(d: Deps) {
  const a = new Hono()
  registerLinkApi(a, d)
  return a
}

function get(a: Hono, path: string, token: string) {
  return a.request(path, { headers: { 'X-TurboLLM-Auth': token } })
}

function post(a: Hono, path: string, token: string, body?: unknown) {
  return a.request(path, {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function del(a: Hono, path: string, token: string) {
  return a.request(path, { method: 'DELETE', headers: { 'X-TurboLLM-Auth': token } })
}

// ---- read ----

test('read lists in-flight downloads with progress', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:read'])], [
    rec({ id: 'dl-1', received: 250, total: 1000, status: 'downloading' }),
    rec({ id: 'dl-2', received: 0, total: 500, status: 'queued', dest: POSIX_DEST }),
  ])
  const res = await get(app(h.d), '/api/link/v1/downloads', 'tllm-a')
  assert.equal(res.status, 200)
  const body = await res.json() as { downloads: Array<Record<string, unknown>> }
  assert.equal(body.downloads.length, 2)
  assert.equal(body.downloads[0]!.id, 'dl-1')
  assert.equal(body.downloads[0]!.received, 250)
  assert.equal(body.downloads[0]!.total, 1000)
  assert.equal(body.downloads[0]!.status, 'downloading')
  assert.equal(body.downloads[0]!.bytesPerSec, 1024)
  assert.equal(body.downloads[0]!.repo, 'Qwen/Qwen3-35B-GGUF')
  assert.equal(body.downloads[1]!.status, 'queued')
})

test('read is 403 without downloads:read — never an empty list', async () => {
  const h = mkDeps([key('tllm-a', ['models:use'])], [rec({})])
  const res = await get(app(h.d), '/api/link/v1/downloads', 'tllm-a')
  assert.equal(res.status, 403)
  const body = await res.json() as { error: { code: string; capability: string } }
  assert.equal(body.error.code, 'forbidden')
  assert.equal(body.error.capability, 'downloads:read')
  // An empty 200 would read as "the host has no downloads" and send the user debugging
  // the wrong machine. The refusal must be visible.
  assert.ok(!('downloads' in body))
})

test('an unauthenticated caller cannot reach any downloads route', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:read', 'downloads:write'])], [rec({})])
  const a = app(h.d)
  assert.equal((await a.request('/api/link/v1/downloads')).status, 401)
  assert.equal((await a.request('/api/link/v1/downloads', { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await a.request('/api/link/v1/downloads/dl-1', { method: 'DELETE' })).status, 401)
})

// ---- write gating ----

test('write is 403 with only downloads:read', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:read'])], [rec({})])
  const a = app(h.d)
  const start = await post(a, '/api/link/v1/downloads', 'tllm-a', {
    repo: 'Qwen/Qwen3-35B-GGUF', rfilename: 'qwen3-35b-Q4_K_M.gguf',
  })
  assert.equal(start.status, 403)
  assert.equal((await start.json() as { error: { capability: string } }).error.capability, 'downloads:write')

  const cancel = await del(a, '/api/link/v1/downloads/dl-1', 'tllm-a')
  assert.equal(cancel.status, 403)
  assert.equal((await cancel.json() as { error: { capability: string } }).error.capability, 'downloads:write')

  // Neither refusal may have reached the manager.
  assert.deepEqual(h.enqueued, [])
  assert.deepEqual(h.removed, [])
})

test('downloads:write does NOT imply downloads:read', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:write'])], [rec({})])
  const res = await get(app(h.d), '/api/link/v1/downloads', 'tllm-a')
  assert.equal(res.status, 403)
})

// ---- write happy path ----

test('write enqueues through the host DownloadManager and answers 202', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:write'])], [])
  const res = await post(app(h.d), '/api/link/v1/downloads', 'tllm-a', {
    repo: 'Qwen/Qwen3-35B-GGUF', rfilename: 'qwen3-35b-Q4_K_M.gguf', size: 1000, sha256: 'abc123',
  })
  assert.equal(res.status, 202)
  const body = await res.json() as { downloads: Array<Record<string, unknown>> }
  assert.equal(body.downloads.length, 1)
  assert.equal(body.downloads[0]!.id, 'dl-new')
  assert.equal(h.enqueued.length, 1)
  assert.equal(h.enqueued[0]!.repo, 'Qwen/Qwen3-35B-GGUF')
  assert.equal(h.enqueued[0]!.rfilename, 'qwen3-35b-Q4_K_M.gguf')
  assert.equal(h.enqueued[0]!.size, 1000)
})

test('the peer\'s raw body never reaches the manager — subdir and url are dropped', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:write'])], [])
  const res = await post(app(h.d), '/api/link/v1/downloads', 'tllm-a', {
    repo: 'Qwen/Qwen3-35B-GGUF',
    rfilename: 'qwen3-35b-Q4_K_M.gguf',
    // `subdir` is join()ed onto the host's model dir unsanitised, and `url` makes the host
    // fetch an arbitrary origin. Neither is a peer's to supply (same rule as ADR-139's
    // modelPath on load).
    subdir: '..\\..\\Windows\\System32',
    url: 'http://169.254.169.254/latest/meta-data/',
    excludeMmproj: true,
  })
  assert.equal(res.status, 202)
  assert.equal(h.enqueued.length, 1)
  assert.equal(h.enqueued[0]!.subdir, undefined)
  assert.equal(h.enqueued[0]!.url, undefined)
  assert.equal(h.enqueued[0]!.excludeMmproj, undefined)
})

// ---- malformed input ----

test('a malformed repo id is a clean 400 — no download is spawned, and it is not a 500', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:write'])], [])
  const a = app(h.d)
  const bad = [
    { repo: 'not-a-repo', rfilename: 'x.gguf' },
    { repo: '', rfilename: 'x.gguf' },
    { repo: '../../etc', rfilename: 'x.gguf' },
    { repo: 'a/b/c', rfilename: 'x.gguf' },
    { repo: 42, rfilename: 'x.gguf' },
    { rfilename: 'x.gguf' },
    { repo: 'Qwen/Qwen3-35B-GGUF' },
    { repo: 'Qwen/Qwen3-35B-GGUF', rfilename: '../../../etc/passwd' },
    { repo: 'Qwen/Qwen3-35B-GGUF', rfilename: 'notes.txt' },
  ]
  for (const body of bad) {
    const res = await post(a, '/api/link/v1/downloads', 'tllm-a', body)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'invalid_request')
  }
  assert.deepEqual(h.enqueued, [])
})

test('a body that is not JSON at all is a 400, not a 500', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:write'])], [])
  const res = await app(h.d).request('/api/link/v1/downloads', {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': 'tllm-a', 'content-type': 'application/json' },
    body: 'not json{{',
  })
  assert.equal(res.status, 400)
  assert.deepEqual(h.enqueued, [])
})

test('a DownloadError from the host surfaces with its own code and status', async () => {
  const h = mkDeps(
    [key('tllm-a', ['downloads:write'])], [],
    { enqueueThrows: new DownloadError('no_model_dir', 'Add a model folder in Settings before downloading.') },
  )
  const res = await post(app(h.d), '/api/link/v1/downloads', 'tllm-a', {
    repo: 'Qwen/Qwen3-35B-GGUF', rfilename: 'qwen3-35b-Q4_K_M.gguf',
  })
  assert.equal(res.status, 409)
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'no_model_dir')
})

test('an unexpected host error is a 500 that discloses nothing about the host', async () => {
  const h = mkDeps(
    [key('tllm-a', ['downloads:write'])], [],
    { enqueueThrows: new Error("EPERM: operation not permitted, mkdir 'D:\\models\\qwen3'") },
  )
  const res = await post(app(h.d), '/api/link/v1/downloads', 'tllm-a', {
    repo: 'Qwen/Qwen3-35B-GGUF', rfilename: 'qwen3-35b-Q4_K_M.gguf',
  })
  assert.equal(res.status, 500)
  const text = await res.text()
  assert.ok(!text.includes(':\\'), 'leaked a windows path in the 500 body')
  assert.ok(!text.includes('EPERM'), 'relayed a raw host error message')
})

// ---- cancellation ----

test('cancelling a download the peer did not start still works — downloads are host-owned', async () => {
  // The record was created locally on the host; nothing associates it with any link, and
  // no per-link ownership model exists to consult.
  const h = mkDeps([key('tllm-a', ['downloads:write'])], [rec({ id: 'started-locally' })])
  const res = await del(app(h.d), '/api/link/v1/downloads/started-locally', 'tllm-a')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.deepEqual(h.removed, ['started-locally'])
})

test('cancelling an unknown id is a clean 404', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:write'])], [rec({ id: 'dl-1' })])
  const res = await del(app(h.d), '/api/link/v1/downloads/nope', 'tllm-a')
  assert.equal(res.status, 404)
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'no_such_download')
})

// ---- the leak assertion ----

test('no host filesystem detail crosses the façade on ANY downloads outcome', async () => {
  const records = [
    rec({ id: 'dl-1', dest: WIN_DEST }),
    rec({
      id: 'dl-2',
      dest: POSIX_DEST,
      status: 'error',
      // The real DownloadManager stores a raw `Error.message` here — for an fs failure
      // that is a full absolute path. This is the third instance of this class in this
      // feature (launchCommand, then engine.error's log tail).
      error: "ENOENT: no such file or directory, open '/home/dev/models/gemma-27b.gguf.part'",
    }),
  ]
  const cases: Array<[string, () => Response | Promise<Response>]> = []
  const mk = (caps: string[], recs: DownloadRecord[]) => mkDeps([key('tllm-a', caps)], recs)

  const readH = mk(['downloads:read'], records)
  cases.push(['read', () => get(app(readH.d), '/api/link/v1/downloads', 'tllm-a')])

  const writeH = mk(['downloads:write'], records)
  cases.push(['write ok', () => post(app(writeH.d), '/api/link/v1/downloads', 'tllm-a', {
    repo: 'Qwen/Qwen3-35B-GGUF', rfilename: 'qwen3-35b-Q4_K_M.gguf',
  })])
  cases.push(['write 400', () => post(app(writeH.d), '/api/link/v1/downloads', 'tllm-a', { repo: 'bad' })])
  cases.push(['delete ok', () => del(app(writeH.d), '/api/link/v1/downloads/dl-1', 'tllm-a')])
  cases.push(['delete 404', () => del(app(writeH.d), '/api/link/v1/downloads/nope', 'tllm-a')])
  cases.push(['read 403', () => get(app(writeH.d), '/api/link/v1/downloads', 'tllm-a')])

  for (const [label, run] of cases) {
    const text = await (await run()).text()
    assert.ok(!text.includes(':\\'), `${label}: leaked a windows path`)
    assert.ok(!text.includes('D:\\models'), `${label}: leaked the model dir`)
    assert.ok(!/\/(home|Users|root|var|mnt)\//.test(text), `${label}: leaked a posix absolute path`)
    assert.ok(!text.includes(WIN_DEST), `${label}: leaked the windows dest`)
    assert.ok(!text.includes(POSIX_DEST), `${label}: leaked the posix dest`)
    assert.ok(!text.includes('ENOENT'), `${label}: relayed a raw host error message`)
    assert.ok(!text.includes('.part'), `${label}: leaked a partial-file path`)
  }
})

test('the read payload is an allowlist projection, not the raw record', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:read'])], [rec({})])
  const res = await get(app(h.d), '/api/link/v1/downloads', 'tllm-a')
  const body = await res.json() as { downloads: Array<Record<string, unknown>> }
  const row = body.downloads[0]!
  // Every field is decided deliberately; a spread of the record would add the next one
  // by default. `dest` and `url` are host-private, `sha256` has no peer-side use.
  assert.deepEqual(
    Object.keys(row).sort(),
    ['bytesPerSec', 'createdAt', 'error', 'id', 'name', 'received', 'repo', 'status', 'total'],
  )
  // `name` is a bare filename, never a path fragment.
  assert.ok(!String(row.name).includes('/') && !String(row.name).includes('\\'))
})

test('an errored download reports the failure without relaying the host message', async () => {
  const h = mkDeps([key('tllm-a', ['downloads:read'])], [
    rec({ status: 'error', error: "EACCES: permission denied, open 'D:\\models\\x.part'" }),
  ])
  const res = await get(app(h.d), '/api/link/v1/downloads', 'tllm-a')
  const body = await res.json() as { downloads: Array<{ status: string; error: string | null }> }
  assert.equal(body.downloads[0]!.status, 'error')
  // The peer must still be able to SEE that it failed — the fact is not the leak, the
  // host-authored free text is.
  assert.equal(typeof body.downloads[0]!.error, 'string')
  assert.ok(!body.downloads[0]!.error!.includes('EACCES'))
})

// ---- LinkClient ----

function client(fetchImpl: typeof fetch) {
  return new LinkClient({ baseUrl: 'https://host.example', token: 'tllm-a' }, { fetchImpl })
}

function jsonRes(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('LinkClient.downloads reads the façade list', async () => {
  const seen: string[] = []
  const c = client((async (url: string) => {
    seen.push(url)
    return jsonRes({ downloads: [{ id: 'dl-1', name: 'x.gguf', repo: 'a/b', total: 10, received: 5, status: 'downloading', error: null, bytesPerSec: 2, createdAt: 'c' }] }, 200)
  }) as unknown as typeof fetch)
  const res = await c.downloads()
  assert.equal(res.kind, 'downloads')
  assert.deepEqual(seen, ['https://host.example/api/link/v1/downloads'])
  assert.equal((res as { downloads: Array<{ id: string }> }).downloads[0]!.id, 'dl-1')
})

test('LinkClient.downloads drops a row without a usable id rather than half-adopting it', async () => {
  const c = client((async () => jsonRes({ downloads: [{ name: 'x.gguf' }, 'nonsense', null] }, 200)) as unknown as typeof fetch)
  const res = await c.downloads()
  assert.equal(res.kind, 'downloads')
  assert.deepEqual((res as { downloads: unknown[] }).downloads, [])
})

test('LinkClient.startDownload posts repo + rfilename to the façade', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const c = client((async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return jsonRes({ downloads: [] })
  }) as unknown as typeof fetch)
  const res = await c.startDownload('Qwen/Qwen3-35B-GGUF', 'q.gguf', { size: 5, sha256: 'h' })
  assert.equal(res.kind, 'accepted')
  assert.equal(seen[0]!.url, 'https://host.example/api/link/v1/downloads')
  assert.equal(seen[0]!.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), {
    repo: 'Qwen/Qwen3-35B-GGUF', rfilename: 'q.gguf', size: 5, sha256: 'h',
  })
  assert.equal((seen[0]!.init.headers as Record<string, string>)['X-TurboLLM-Auth'], 'tllm-a')
})

test('LinkClient.cancelDownload DELETEs the id', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const c = client((async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return jsonRes({ ok: true }, 200)
  }) as unknown as typeof fetch)
  const res = await c.cancelDownload('dl 1/x')
  assert.equal(res.kind, 'accepted')
  // The id is path-encoded — an id with a slash must not forge a different route.
  assert.equal(seen[0]!.url, 'https://host.example/api/link/v1/downloads/dl%201%2Fx')
  assert.equal(seen[0]!.init.method, 'DELETE')
})

test('LinkClient download methods never throw — they inherit call()\'s total contract', async () => {
  const boom = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
  assert.deepEqual(await client(boom).downloads(), { kind: 'network' })
  assert.deepEqual(await client(boom).startDownload('a/b', 'x.gguf'), { kind: 'network' })
  assert.deepEqual(await client(boom).cancelDownload('dl-1'), { kind: 'network' })
})

test('LinkClient surfaces a downloads capability refusal as an http probe', async () => {
  const denied = (async () => new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  assert.deepEqual(await client(denied).downloads(), { kind: 'http', status: 403 })
  assert.deepEqual(await client(denied).startDownload('a/b', 'x.gguf'), { kind: 'http', status: 403 })
  assert.deepEqual(await client(denied).cancelDownload('dl-1'), { kind: 'http', status: 403 })
})

test('LinkClient rejects a non-JSON 200 from the downloads list rather than reporting success', async () => {
  const html = (async () => new Response('<html>captive portal</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  assert.deepEqual(await client(html).downloads(), { kind: 'network' })
})

test('LinkClient treats a downloads list of the wrong shape as unknown, not empty', async () => {
  const odd = (async () => jsonRes({ downloads: 'soon' }, 200)) as unknown as typeof fetch
  assert.deepEqual(await client(odd).downloads(), { kind: 'network' })
})
