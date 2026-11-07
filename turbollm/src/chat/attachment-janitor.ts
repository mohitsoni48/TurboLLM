// The background half of chat images as files (scalability review 2.7, attachments.ts). Two minutes after startup
// (never during boot) and then once a day, it:
//  - moves images still stored inline in messages.attachments (rows written before 2.7) into files, in the app's own
//    (local) rows only: an External Chat API row keeps what its client wrote. Per row: the
//    files are written first, then the row is swapped to references only if it still holds what was read
//    (replaceMessageAttachments). A crash in between leaves the row inline and a file no row names; the next run
//    converts the row again and reuses that file (same bytes, same name).
//  - deletes files no message names any more: a deleted chat or message (by the user, the retention sweep, a Code
//    session delete) leaves its images behind, and one picture can be named by many rows. Only files older than the
//    grace period go, so an image saved for a row not yet written survives.
// Desktop runs node:sqlite synchronously on the event loop, so both walk messages in windows of rowids with a yield to
// the event loop between windows, and the backfill holds at most one row's images in memory at a time.
import { daemonTick } from '../util/daemon-ticks'
import { attachmentRefId } from './attachments'
import type { ConversationStore } from './db'
import { LOCAL_SCOPE } from './store/chat-store'

const FIRST_RUN_DELAY_MS = 2 * 60_000
const RUN_INTERVAL_MS = 24 * 60 * 60_000
const DEFAULT_SCAN_WINDOW = 500
const DEFAULT_GRACE_MS = 60 * 60_000
const INLINE_IMAGE = '"data:image/'
const REFERENCE = '"attachment:'

export interface AttachmentJanitorDeps {
  db: ConversationStore
  log: (line: string) => void
  /** How old an unreferenced file must be before it is deleted. */
  graceMs?: number
  /** Message rowids per scan window. */
  scanWindow?: number
}

export interface AttachmentJanitorSummary {
  converted: number
  deleted: number
  batches: number
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

function parseAttachments(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

export class AttachmentJanitor {
  private inFlight: Promise<AttachmentJanitorSummary | null> | null = null
  private firstRun: ReturnType<typeof setTimeout> | null = null
  private daily: ReturnType<typeof setInterval> | null = null

  constructor(private readonly d: AttachmentJanitorDeps) {}

  /** Neither timer keeps the process alive; the daily one is a daemonTick, which the restart keeper stops. */
  start(): void {
    this.firstRun = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS)
    this.firstRun.unref()
    this.daily = daemonTick(() => void this.run(), RUN_INTERVAL_MS)
  }

  stop(): void {
    if (this.firstRun) clearTimeout(this.firstRun)
    if (this.daily) clearInterval(this.daily)
    this.firstRun = this.daily = null
  }

  /** Runs the backfill and the collection, or joins the run already under way. Null when it failed (logged). */
  run(): Promise<AttachmentJanitorSummary | null> {
    this.inFlight ??= this.work().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async work(): Promise<AttachmentJanitorSummary | null> {
    const summary: AttachmentJanitorSummary = { converted: 0, deleted: 0, batches: 0 }
    if (!this.d.db.attachments.enabled) return summary
    try {
      await this.backfill(summary)
      await this.collect(summary)
      if (summary.converted || summary.deleted) {
        this.d.log(`[attachments] moved images of ${summary.converted} messages into files; deleted ${summary.deleted} unused image files`)
      }
      return summary
    } catch (e) {
      this.d.log(`[attachments] attachment cleanup failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  private async backfill(summary: AttachmentJanitorSummary): Promise<void> {
    await this.eachMessageWith(INLINE_IMAGE, LOCAL_SCOPE.tenant, summary, async (id) => {
      const json = this.d.db.messageAttachmentsJson(id)
      if (json === null) return
      const attachments = parseAttachments(json)
      const stored = await this.d.db.attachments.save(attachments)
      if (stored.every((a, i) => a === attachments[i])) return
      if (this.d.db.replaceMessageAttachments(id, json, stored)) summary.converted++
    })
  }

  private async collect(summary: AttachmentJanitorSummary): Promise<void> {
    const referenced = new Set<string>()
    await this.eachMessageWith(REFERENCE, undefined, summary, async (id) => {
      for (const attachment of parseAttachments(this.d.db.messageAttachmentsJson(id) ?? '[]')) {
        const fileId = attachmentRefId(attachment)
        if (fileId) referenced.add(fileId)
      }
    })
    summary.deleted = await this.d.db.attachments.collectGarbage(referenced, this.d.graceMs ?? DEFAULT_GRACE_MS)
  }

  /** Each message (of `tenant` only, when given) whose attachments contain `needle`. */
  private async eachMessageWith(needle: string, tenant: string | undefined, summary: AttachmentJanitorSummary, fn: (id: string) => Promise<void>): Promise<void> {
    let after: number | null = 0
    while (after !== null) {
      const window = this.d.db.messagesWithAttachment(needle, after, this.d.scanWindow ?? DEFAULT_SCAN_WINDOW, tenant)
      for (const id of window.ids) await fn(id)
      summary.batches++
      after = window.next
      await yieldToEventLoop()
    }
  }
}
