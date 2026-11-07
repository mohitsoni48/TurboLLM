// Chat search's full-text index (scalability review 2.2, db.ts SEARCH_INDEX_SCHEMA) is created empty by the
// migration that adds it, so opening a long history never stalls the boot. This job then indexes the rows written
// before it existed, a batch of rowids per transaction with a yield to the event loop between batches (desktop runs
// node:sqlite synchronously on the event loop). Progress is persisted in the database, so a stop or a crash resumes
// where it was. Until it finishes, search keeps its LIKE path.
import type { ConversationStore } from './db'

const START_DELAY_MS = 5_000
const DEFAULT_BATCH_ROWS = 2_000

export interface SearchIndexBackfillDeps {
  db: ConversationStore
  log: (line: string) => void
  /** Rowids per batch (one transaction). */
  batchRows?: number
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export class SearchIndexBackfill {
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly d: SearchIndexBackfillDeps) {}

  /** Starts a few seconds after boot. The timer does not keep the process alive. */
  start(): void {
    this.timer = setTimeout(() => void this.run(), START_DELAY_MS)
    this.timer.unref()
  }

  /** Ends the walk before its next batch; the persisted progress keeps what was indexed. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Indexes every pending row unless stopped first. How many batches it ran; a failure is logged, not thrown. */
  async run(): Promise<number> {
    let batches = 0
    try {
      if (!this.d.db.searchIndexPending) return 0
      this.d.log('[search] indexing earlier chat history for search in the background')
      while (!this.stopped && this.d.db.backfillSearchIndex(this.d.batchRows ?? DEFAULT_BATCH_ROWS)) {
        batches++
        await yieldToEventLoop()
      }
      if (!this.d.db.searchIndexPending) this.d.log(`[search] chat history indexed (${batches} batches)`)
    } catch (e) {
      this.d.log(`[search] indexing chat history failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return batches
  }
}
