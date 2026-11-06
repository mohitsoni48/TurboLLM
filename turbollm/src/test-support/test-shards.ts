import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** CI runs the daemon's unit tests as parallel shards (`.github/workflows/ci.yml`). A shard is named by the
 *  directories under src/ whose test files it runs; `rest` is every other test file, so a new directory, or a new
 *  file anywhere, lands in exactly one shard without anyone editing this list. Balanced by measured per-file time
 *  (Windows, 6 files at once, seconds: engines 332, code 326, rest 239; src/code and src/api are the two largest). */
export const SHARDS = {
  engines: ['engines', 'api', 'chat', 'bench', 'models', 'downloads'],
  code: ['code', 'routines', 'ext', 'tools'],
} as const satisfies Record<string, readonly string[]>

export const SHARD_NAMES = [...Object.keys(SHARDS), 'rest'] as const
export type ShardName = (typeof SHARD_NAMES)[number]

const TEST_FILE = /\.test\.ts$/

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (TEST_FILE.test(entry.name)) out.push(path)
  }
}

/** Every file `npm test` runs: all of src/**\/*.test.ts, then the web/src/lib tests named in package.json's "test"
 *  script (the daemon's own tests of code it shares with the web app). Paths are relative to `root` (turbollm/),
 *  with forward slashes. */
export function allTestFiles(root: string): string[] {
  const found: string[] = []
  walk(join(root, 'src'), found)
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>
  const web = scripts.test.match(/web\/src\/lib\/[\w-]+\.test\.ts/g) ?? []
  return [...found.map((f) => relative(root, f).split(sep).join('/')).sort(), ...web]
}

function shardOf(file: string): ShardName {
  for (const [name, dirs] of Object.entries(SHARDS)) {
    if (dirs.some((d) => file.startsWith(`src/${d}/`))) return name as ShardName
  }
  return 'rest'
}

export function shardFiles(root: string, shard: ShardName): string[] {
  return allTestFiles(root).filter((f) => shardOf(f) === shard)
}

/** The files of the shard CI named, for `list-shard.ts`: throws on a name that is no shard and on a shard with no
 *  files, because an empty list would make `tsx --test` fall back to Node's own file discovery and pass. */
export function requireShardFiles(root: string, shard: string | undefined): string[] {
  if (!(SHARD_NAMES as readonly string[]).includes(shard ?? '')) {
    throw new Error(`unknown shard "${shard}"; the shards are ${SHARD_NAMES.join(', ')}`)
  }
  const files = shardFiles(root, shard as ShardName)
  if (files.length === 0) throw new Error(`shard "${shard}" has no test files`)
  return files
}
