// downloadFile failure carries a stable code (the release-install job vocabulary reads it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../test-support/tmp'
import { downloadFile } from './download'

test('an HTTP failure carries code download_failed and keeps its message text', async () => {
  const dest = join(tmpDir('dlfile-'), 'a.zip')
  const notFound = (async () => new Response('no', { status: 404 })) as typeof fetch
  await assert.rejects(downloadFile('https://x.test/a.zip', dest, undefined, undefined, notFound), (e: Error & { code?: string }) => {
    return e.code === 'download_failed' && e.message === 'download failed: HTTP 404'
  })
})

// A .part that cannot be removed (on Windows, AV or the indexer holding it) must not turn a Cancel into a
// failure: the AbortError is what callers map to a quiet done(). A directory swapped in at the .part path
// stands in for the lock (POSIX lets the write stream keep its unlinked file).
test('a .part that cannot be removed does not replace the AbortError', { skip: process.platform === 'win32' }, async () => {
  const dest = join(tmpDir('dlfile-'), 'a.bin')
  const part = `${dest}.part`
  const hanging = (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(1024))
        },
      }),
      { status: 200 },
    )) as typeof fetch
  const ac = new AbortController()
  const done = downloadFile('https://x.test/a.bin', dest, undefined, ac.signal, hanging)
  for (let i = 0; i < 200 && !(existsSync(part) && statSync(part).size > 0); i++) await new Promise((r) => setTimeout(r, 10))
  unlinkSync(part)
  mkdirSync(part)
  writeFileSync(join(part, 'held'), '')
  ac.abort()
  await assert.rejects(done, (e: Error) => e.name === 'AbortError')
})

for (const url of ['https://x.test/a.zip', 'https://objects.githubusercontent.com/a.zip', 'https://github.com/o/r/releases/download/t/a.zip']) {
  test(`downloadFile sends no Authorization header to ${new URL(url).host}`, async () => {
    const dest = join(tmpDir('dlfile-'), 'a.zip')
    let sent: RequestInit | undefined
    const capture = (async (_input: unknown, init?: RequestInit) => {
      sent = init
      return new Response('bytes', { status: 200 })
    }) as typeof fetch
    await downloadFile(url, dest, undefined, undefined, capture)
    assert.equal(new Headers(sent?.headers).has('authorization'), false)
  })
}
