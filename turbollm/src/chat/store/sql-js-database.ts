// WASM SQLite (sql.js) backend for Android — see sqlite-adapter.ts's header for the full
// design (why this exists, why openSqlDb has to stay synchronous). Real differences from
// node:sqlite's DatabaseSync, all consciously accepted for this target:
//   • In-memory only; flushed to `path` soon after writes and on close() via db.export(). A
//     non-graceful kill (routine on Android — the OS can kill an app any time, and the app's
//     Quit kills its own process) loses writes since the last flush, not since the last close —
//     flushing soon after writes (below) bounds that window instead of only flushing at a clean
//     shutdown, which chat data on Android can't assume ever happens. Each flush replaces the
//     file atomically (temp + rename), so a kill mid-flush costs the writes since the previous
//     flush, never the whole file. flush() also writes on request (POST /api/v1/daemon/flush).
//   • No WAL journal mode / busy_timeout — meaningless for an in-process, single-connection,
//     single-threaded WASM database; both PRAGMAs are stripped out of exec() as no-ops so
//     ConversationStore's migrate() doesn't need an Android-specific branch of its own.
//     foreign_keys is kept, and re-applied after every export() (which resets it).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import initSqlJs, { type Database as SqlJsDb, type SqlJsStatic } from 'sql.js'
import type { SqlDb, SqlStatement, SqlValue } from './sqlite-adapter.js'

/** A flush runs this long after the last write, so a burst of writes (a reply's rows, a chat's
 *  import) is exported once, not once per statement. It used to run only every 10 s: Quit (which
 *  kills the process) or a system kill lost a reply that had finished seconds before, or a new
 *  chat. An export rewrites the whole database (a few ms to tens of ms on a phone, more for a
 *  large one), so a flush per statement is not an option either. */
const FLUSH_SETTLE_MS = 1_000
/** While writes keep coming (a debounce alone would wait for them to stop), the oldest write not
 *  yet on disk is flushed after at most this long. */
const FLUSH_MAX_WAIT_MS = 10_000
/** Flushes are at least this far apart, and a failed one is retried after FLUSH_MAX_WAIT_MS. */
const FLUSH_MIN_GAP_MS = 1_000

let sqlJsModule: SqlJsStatic | null = null
let sqlJsInitPromise: Promise<SqlJsStatic> | null = null

/** Loads the sql.js WASM module exactly once per process. Must be awaited (cli.ts's Android
 *  startup path does this) before the first openSqlJsDatabaseSync() call — that function
 *  throws a clear error rather than hang or silently misbehave if called too early. */
export async function preload(): Promise<void> {
  if (sqlJsModule) return
  if (!sqlJsInitPromise) sqlJsInitPromise = initSqlJs()
  sqlJsModule = await sqlJsInitPromise
}

/** sql.js's C SQLite binding has no bigint support (its own SqlValue type is
 *  `number | string | Uint8Array | null`) — node:sqlite's does, so `SqlValue` (this
 *  module's shared type, matching node:sqlite's SQLInputValue) allows it for desktop parity.
 *  Converts to a decimal string, a safe lossless representation, rather than silently
 *  truncating to `number` (which loses precision above 2^53). None of this codebase's actual
 *  bound values are bigints today — this is a correctness guard against a future one, not a
 *  currently-exercised path. */
function toSqlJsValue(v: SqlValue): number | string | Uint8Array | null {
  return typeof v === 'bigint' ? v.toString() : v
}

/** Normalizes the same two call shapes `SqlStatement` supports — a single named-params
 *  object, or a spread of positional values — into whatever sql.js's own `bind()` expects
 *  (an object for named `$foo` placeholders, an array for positional `?` ones). `undefined`
 *  means "nothing to bind" (a parameterless statement). A lone Buffer/Uint8Array positional
 *  arg must stay positional, not get mistaken for a named-params object — both are
 *  `typeof === 'object'`. */
function bindArgs(params: (SqlValue | Record<string, SqlValue>)[]): Record<string, number | string | Uint8Array | null> | (number | string | Uint8Array | null)[] | undefined {
  if (params.length === 0) return undefined
  const [first] = params
  if (params.length === 1 && typeof first === 'object' && first !== null && !(first instanceof Uint8Array)) {
    const obj = first as Record<string, SqlValue>
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toSqlJsValue(v)]))
  }
  return (params as SqlValue[]).map(toSqlJsValue)
}

/** fsyncs `path`'s parent directory so a rename over `path` survives a power loss or an OS
 *  crash, not just a process kill: the file's own fsync covers its contents, never the
 *  directory entry the rename created. Best-effort by design — Windows refuses to open a
 *  directory this way, and the bytes are already safely in the file by then, so a failure here
 *  must not turn a completed flush into a failed one. */
function fsyncDirectory(path: string): void {
  let dir: number | undefined
  try {
    dir = openSync(dirname(path), 'r')
    fsyncSync(dir)
  } catch {
    /* unsupported here (Windows) — the rename is still atomic, just not crash-durable */
  } finally {
    if (dir !== undefined) closeSync(dir)
  }
}

class SqlJsAdapter implements SqlDb {
  /** The pending flush, armed by the first write after a flush (or by a failed one). One timer,
   *  not one per write: when it fires early (writes kept coming) it re-arms for when it is due. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  // Set by anything that may have written; cleared only by a successful flush, so an idle
  // daemon doesn't rewrite the whole file and a failed flush is retried.
  private dirty = false
  /** When the oldest write not yet on disk was made (FLUSH_MAX_WAIT_MS counts from it). */
  private dirtySince = 0
  /** When the last write was made (FLUSH_SETTLE_MS counts from it). */
  private lastWriteAt = 0
  /** When the last flush ran, written or failed (FLUSH_MIN_GAP_MS counts from it). */
  private lastFlushAt = -Infinity

  constructor(private readonly db: SqlJsDb, private readonly path: string) {}

  private markDirty(): void {
    const now = Date.now()
    this.lastWriteAt = now
    if (!this.dirty) {
      this.dirty = true
      this.dirtySince = now
    }
    if (!this.flushTimer && !this.closed) this.armFlush(now + FLUSH_SETTLE_MS)
  }

  private armFlush(at: number): void {
    // Never more than FLUSH_MAX_WAIT_MS ahead, whatever the clock did (onFlushTimer).
    const delay = Math.min(FLUSH_MAX_WAIT_MS, Math.max(0, at - Date.now()))
    // unref'd: a pending flush never keeps the process alive; close() flushes what is left.
    this.flushTimer = setTimeout(() => this.onFlushTimer(), delay)
    this.flushTimer.unref?.()
  }

  private onFlushTimer(): void {
    this.flushTimer = null
    if (this.closed || !this.dirty) return
    const now = Date.now()
    // The times above are the wall clock's, which a manual time change or a network time
    // correction can set back. One later than now means it was: waiting for it would hold every
    // flush back as long as the clock went back (set back an hour, nothing written for an hour).
    // Such a flush runs at once instead. Timers run on a clock that is never set back, so this
    // one has waited what it was armed for.
    if (this.lastFlushAt > now || this.lastWriteAt > now || this.dirtySince > now) {
      this.flush()
      return
    }
    const due = Math.max(
      this.lastFlushAt + FLUSH_MIN_GAP_MS,
      Math.min(this.lastWriteAt + FLUSH_SETTLE_MS, this.dirtySince + FLUSH_MAX_WAIT_MS),
    )
    if (due > now) {
      this.armFlush(due)
      return
    }
    this.flush()
  }

  /** Writes the snapshot to a sibling temp file, fsyncs it, then renames it over `path`, so
   *  a kill mid-write leaves the previous snapshot intact instead of a truncated file (which
   *  would fail to load and lose every conversation, not just the writes since the last flush).
   *  Returns whether everything written so far is on disk (true too when nothing was pending).
   *  Also called on request (ConversationStore.flush, POST /api/v1/daemon/flush). */
  flush(): boolean {
    if (this.closed || !this.dirty) return true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.lastFlushAt = Date.now()
    const tmp = `${this.path}.tmp`
    try {
      const bytes = this.exportPreservingForeignKeys()
      const fd = openSync(tmp, 'w')
      try {
        writeFileSync(fd, bytes) // loops on short writes; a bare writeSync doesn't
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.path)
      // Before `dirty` is cleared: the rename is what publishes the snapshot, and the
      // directory entry it created is only durable once the directory itself is synced.
      fsyncDirectory(this.path)
      this.dirty = false
      return true
    } catch {
      // Best-effort — the in-memory DB stays usable even if a flush fails (e.g. disk full);
      // `dirty` stays set and the flush is retried after FLUSH_MAX_WAIT_MS (counted afresh, so
      // a failing disk is not rewritten every second while writes keep coming).
      this.dirtySince = this.lastFlushAt
      if (!this.closed) this.armFlush(this.lastFlushAt + FLUSH_MAX_WAIT_MS)
      return false
    }
  }

  /** sql.js's export() closes and reopens the underlying connection, which resets
   *  connection-scoped PRAGMAs — foreign_keys drops back to OFF, silently disabling the
   *  schema's ON DELETE CASCADEs after the first flush. Restore it if it was on.
   *
   *  The re-apply is deliberately NOT in a `finally`: export() does `sqlite3_close_v2` before
   *  reading the file back and re-opening it (sql.js's `exportDatabase`), so once it throws
   *  there is no live handle to run this PRAGMA against, and running it anyway would throw a
   *  second time and replace the error that actually failed the flush. */
  private exportPreservingForeignKeys(): Uint8Array {
    const fkOn = this.db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0] === 1
    const bytes = this.db.export()
    if (fkOn) this.db.exec('PRAGMA foreign_keys = ON')
    return bytes
  }

  exec(sql: string): void {
    // Drop only the unsupported PRAGMA statements, not the whole string: ConversationStore's
    // `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = …` would
    // otherwise lose its foreign_keys statement along with them.
    const rest = sql.replace(/\bpragma\s+(?:journal_mode|busy_timeout)\b[^;]*;?/gi, '').trim()
    if (!rest) return
    this.db.exec(rest)
    this.markDirty()
  }

  prepare(sql: string): SqlStatement {
    const db = this.db
    const markDirty = () => this.markDirty()
    // get()/all() are reads everywhere today, but a statement that isn't a plain SELECT
    // (e.g. a future INSERT … RETURNING) must still be flushed.
    const mayWrite = !/^\s*select\b/i.test(sql)
    return {
      get(...params: SqlValue[] | [Record<string, SqlValue>]) {
        if (mayWrite) markDirty()
        const stmt = db.prepare(sql)
        try {
          const bound = bindArgs(params)
          if (bound !== undefined) stmt.bind(bound)
          // step() returning false means zero rows — matches DatabaseSync's `undefined`,
          // unlike sql.js's own getAsObject(), which returns an all-undefined-fields object
          // for a query with no rows instead of signaling "no row" at all.
          return stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : undefined
        } finally {
          stmt.free()
        }
      },
      all(...params: SqlValue[] | [Record<string, SqlValue>]) {
        if (mayWrite) markDirty()
        const stmt = db.prepare(sql)
        const rows: Record<string, unknown>[] = []
        try {
          const bound = bindArgs(params)
          if (bound !== undefined) stmt.bind(bound)
          while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>)
        } finally {
          stmt.free()
        }
        return rows
      },
      run(...params: SqlValue[] | [Record<string, SqlValue>]) {
        markDirty()
        const stmt = db.prepare(sql)
        try {
          const bound = bindArgs(params)
          if (bound !== undefined) stmt.run(bound as never)
          else stmt.run()
        } finally {
          stmt.free()
        }
        return { changes: db.getRowsModified() }
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.flush() // before `closed` is set — flush() is a no-op once it is
    this.closed = true
    if (this.flushTimer) clearTimeout(this.flushTimer) // a failed flush's retry
    this.flushTimer = null
    this.db.close()
  }
}

/** Opens (or creates) a sql.js-backed database at `path`. Synchronous — requires preload()
 *  to have already resolved (cli.ts's Android startup sequence guarantees this before any
 *  ConversationStore gets constructed). Loads any existing bytes at `path` as the starting
 *  state; the file is otherwise a snapshot written soon after writes and at close, not
 *  continuously written the way node:sqlite's file is. */
export function openSqlJsDatabaseSync(path: string): SqlDb {
  if (!sqlJsModule) {
    throw new Error(
      'sql.js was not preloaded — call preloadSqlJs() (sqlite-adapter.ts) and await it ' +
        'before constructing any ConversationStore on Android.',
    )
  }
  const db = existsSync(path) ? new sqlJsModule.Database(new Uint8Array(readFileSync(path))) : new sqlJsModule.Database()
  return new SqlJsAdapter(db, path)
}
