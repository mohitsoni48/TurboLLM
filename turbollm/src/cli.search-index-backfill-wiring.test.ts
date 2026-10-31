// Source-level guard (cli.ts boots the daemon on import, see cli.daily-active-wiring.test.ts): chat search's index
// backfill (chat/search-index-backfill.ts, scalability review 2.2) is started with the daemon, off the boot path, and
// stopped on both the restart and the shutdown path, like the retention sweeper beside it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLI = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'utf8')

test('the search index backfill is built on the chat store and started', () => {
  assert.match(CLI, /const searchIndexBackfill = new SearchIndexBackfill\(\{\s*db,/)
  assert.match(CLI, /searchIndexBackfill\.start\(\)/)
})

test('the search index backfill is stopped wherever the retention sweeper is', () => {
  const stops = (name: string) => CLI.split(`${name}.stop()`).length - 1
  assert.ok(stops('retentionSweeper') >= 2)
  assert.equal(stops('searchIndexBackfill'), stops('retentionSweeper'))
})
