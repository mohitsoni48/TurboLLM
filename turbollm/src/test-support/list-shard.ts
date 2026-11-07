import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireShardFiles } from './test-shards'

// Prints one shard's test files, one per line, for CI (see the unit job in .github/workflows/ci.yml). Exits 1 with a
// message on an unknown or empty shard, so the job fails rather than running the wrong tests.
try {
  console.log(requireShardFiles(join(dirname(fileURLToPath(import.meta.url)), '..', '..'), process.argv[2]).join('\n'))
} catch (e) {
  console.error(`list-shard.ts: ${(e as Error).message}`)
  process.exit(1)
}
