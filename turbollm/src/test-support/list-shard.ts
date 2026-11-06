import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHARD_NAMES, type ShardName, shardFiles } from './test-shards'

// Prints one shard's test files, one per line, for CI: `npx tsx --test $(npx tsx src/test-support/list-shard.ts engines)`.
const shard = process.argv[2] as ShardName
if (!SHARD_NAMES.includes(shard)) {
  console.error(`usage: list-shard.ts <${SHARD_NAMES.join('|')}>`)
  process.exit(2)
}
console.log(shardFiles(join(dirname(fileURLToPath(import.meta.url)), '..', '..'), shard).join('\n'))
