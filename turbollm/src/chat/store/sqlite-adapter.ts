// Platform-neutral SQLite interface (spec 01 §4). Desktop/server platforms use Node's
// built-in `node:sqlite` (DatabaseSync, Node 22.13+). Android's embedded `nodejs-mobile`
// runtime ships Node 18.20.4 — confirmed live against the actual vendored runtime (see the
// TurboLLM Android repo's PROVENANCE.md and its emulator verification) — which predates
// `node:sqlite` entirely (added in Node 22.5+, unflagged at 22.13+). Android gets a WASM
// SQLite (`sql.js`) implementation behind this exact same interface instead.
//
// This is the ANDROID-GATED fix for the Android blueprint's Spike C: an earlier attempt at
// this swapped `node:sqlite` for `sql.js` globally (every platform, desktop included) and
// dropped the whole product's `engines.node` floor — wrong scope, reverted. Only Android
// takes the `sql.js` path; every other platform's behavior is byte-for-byte unchanged.
//
// Deliberately SYNCHRONOUS (openSqlDb, not async): ConversationStore's constructor — and
// ~100 test call sites across the codebase — construct it as `new ConversationStore(dir)`,
// not `await`. node:sqlite's DatabaseSync is naturally synchronous, so desktop needs
// nothing special. sql.js's WASM module load IS inherently async, but only its one-time
// module bootstrap is — constructing an actual Database from an already-loaded module is
// synchronous. So Android's entry point calls `preloadSqlJs()` once, early, before any
// ConversationStore gets constructed (see cli.ts) — by the time the constructor runs, the
// module is already resident and opening a database is synchronous like everywhere else.
//
// Only the subset of DatabaseSync's API that ConversationStore/SqliteChatStore actually use.
import { createRequire } from 'node:module'

// A real `require()` still resolves synchronously even inside an ESM module/bundle — unlike
// dynamic `import()`, which always returns a Promise. Needed so openSqlDb() can stay
// synchronous (see the header) while only resolving 'node:sqlite' or './sql-js-database.js'
// at CALL time, not at module-evaluation time — a top-level static `import ... from
// 'node:sqlite'` would throw ERR_UNKNOWN_BUILTIN_MODULE on Android's Node 18.20.4 the moment
// this file loads, even though that branch would never execute there.
const requireSync = createRequire(import.meta.url)

export type SqlValue = null | number | bigint | string | Buffer | Uint8Array

// node:sqlite's real StatementSync.get/all/run accept EITHER a single named-parameters
// object ($foo-style placeholders) OR a spread of positional values (?-style placeholders)
// — this codebase uses both forms (e.g. `.get(id)` and `.get({ $id: id })`), so the
// interface has to accept both rather than just the named-object shape.
export interface SqlStatement {
  get(...params: SqlValue[] | [Record<string, SqlValue>]): Record<string, unknown> | undefined
  all(...params: SqlValue[] | [Record<string, SqlValue>]): Record<string, unknown>[]
  run(...params: SqlValue[] | [Record<string, SqlValue>]): { changes: number; lastInsertRowid?: number | bigint }
}

export interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

// Cached from preloadSqlJs()'s one dynamic import — NOT re-resolved via requireSync at call
// time. A bundler (tsup/esbuild) rewrites a dynamic `import('./sql-js-database.js')` to
// point at wherever it actually placed that chunk (it gets content-hashed into its own
// output file, code-split off from cli.js); a separate `require('./sql-js-database.js')`
// elsewhere is opaque to that rewrite and would look for a literal file that doesn't exist
// in the built output. One load, cached, avoids the mismatch entirely.
let androidOpenFn: ((path: string) => SqlDb) | null = null

/** Android only. Loads sql.js's WASM module once; a no-op on every other platform. Must be
 *  awaited before the first `openSqlDb()` call on Android (cli.ts's startup sequence does
 *  this) — `openSqlDb()` throws a clear error if called too early instead of hanging or
 *  silently misbehaving. */
export async function preloadSqlJs(): Promise<void> {
  if (process.platform !== 'android') return
  const mod = await import('./sql-js-database.js')
  await mod.preload()
  androidOpenFn = mod.openSqlJsDatabaseSync
}

/** Opens the platform-appropriate SQLite backend for `path`, synchronously — see the module
 *  header for why this can't be async despite Android's backend needing WASM loaded first. */
export function openSqlDb(path: string): SqlDb {
  if (process.platform === 'android') {
    if (!androidOpenFn) {
      throw new Error(
        'sql.js was not preloaded — call preloadSqlJs() and await it before constructing ' +
          'any ConversationStore on Android.',
      )
    }
    return androidOpenFn(path)
  }
  const { DatabaseSync } = requireSync('node:sqlite') as typeof import('node:sqlite')
  return new DatabaseSync(path) as unknown as SqlDb
}
