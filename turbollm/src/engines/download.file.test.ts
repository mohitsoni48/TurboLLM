// downloadFile failure carries a stable code (the release-install job vocabulary reads it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
