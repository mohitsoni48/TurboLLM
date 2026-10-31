// Source-level guard (cli.ts boots the daemon on import, see cli.daily-active-wiring.test.ts): the chat image
// janitor (chat/attachment-janitor.ts, scalability review 2.7) is started with the daemon and stopped on both the
// restart and the shutdown path, like the retention sweeper beside it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLI = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'utf8')

test('the attachment janitor is built on the chat store and started', () => {
  assert.match(CLI, /const attachmentJanitor = new AttachmentJanitor\(\{\s*db,/)
  assert.match(CLI, /attachmentJanitor\.start\(\)/)
})

test('the attachment janitor is stopped wherever the retention sweeper is', () => {
  const stops = (name: string) => CLI.split(`${name}.stop()`).length - 1
  assert.ok(stops('retentionSweeper') >= 2)
  assert.equal(stops('attachmentJanitor'), stops('retentionSweeper'))
})
