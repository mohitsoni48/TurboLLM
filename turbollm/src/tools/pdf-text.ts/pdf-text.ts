// fetch_url's PDF support, host side: response detection plus the orchestration that runs the
// actual parse OFF the daemon's main thread. pdfjs-dist is imported only by the worker-side
// module (pdf-text-extract.ts), never here — the daemon's own process does not load it at all.
//
// Why a worker: a 2.8 MB real-world PDF raised the parsing process's RSS by ~200 MB for ~1 s
// on desktop Linux when parsed in-process. On the daemon's only thread that stalls the whole
// HTTP API and streaming for every client, and Android is a first-class target with far less
// headroom. run_code had the same shape of problem; this mirrors its answer (a real
// node:worker_threads Worker, a concurrency slot cap, a watchdog terminate) with one honest
// difference spelled out below.

import { Worker } from 'node:worker_threads'

/** Pages read before stopping — re-exported from the worker side so tests and callers see
 *  one value. */
export const PDF_MAX_PAGES = 40

/** True for a reply whose bytes should be parsed as a PDF: the header says so, or a
 *  missing/generic one names a .pdf in the URL path (many static hosts serve octet-stream
 *  for everything). A real content type always wins over the path. */
export function isPdfResponse(contentType: string, url: string): boolean {
  if (contentType.toLowerCase().includes('application/pdf')) return true
  if (contentType && !contentType.toLowerCase().includes('octet-stream')) return false
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}

/** Wall-clock budget for one parse before the worker is terminated. A normal document parses
 *  in well under a second; this exists for the adversarial case — a malformed object graph
 *  that sends pdfjs into quadratic or looping work, which no byte or page cap can bound. */
export const PDF_PARSE_TIMEOUT_MS = 20_000

/** Parses allowed in flight at once. Each worker is a real OS thread plus pdfjs's allocation
 *  footprint; run_code caps its (lighter) workers at 4, PDFs get fewer for the same reason. */
export const PDF_MAX_CONCURRENT_WORKERS = 2

/** Longest a parse may QUEUE behind busy workers before giving up. The watchdog bounds one
 *  parse; without this bound a caller could wait behind a whole queue of 20 s parses and the
 *  end-to-end budget would mean nothing. */
export const PDF_PARSE_QUEUE_TIMEOUT_MS = 30_000

let activePdfWorkers = 0
const pdfWaiters: Array<() => void> = []

/** Resolves true with a slot held, or false when the wait ran over budget (the waiter is
 *  removed, so a lapsed caller never takes a slot it walked away from). */
function acquirePdfSlot(waitMs: number): Promise<boolean> {
  if (activePdfWorkers < PDF_MAX_CONCURRENT_WORKERS) {
    activePdfWorkers++
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const waiter = () => {
      clearTimeout(timer)
      activePdfWorkers++
      resolve(true)
    }
    const timer = setTimeout(() => {
      const i = pdfWaiters.indexOf(waiter)
      if (i >= 0) pdfWaiters.splice(i, 1)
      resolve(false)
    }, waitMs)
    pdfWaiters.push(waiter)
  })
}

function releasePdfSlot(): void {
  activePdfWorkers--
  pdfWaiters.shift()?.()
}

export type PdfParseOutcome = { kind: 'text'; text: string } | { kind: 'unreadable' } | { kind: 'timeout' } | { kind: 'busy' }

const WORKER_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const WORKER_PATH = new URL(`./pdf-text-worker${WORKER_EXT}`, import.meta.url)

/** Parse a PDF's text layer in a dedicated worker thread. Returns the extracted text, or a
 *  failure kind execFetchUrl turns into a static, content-free note. Never throws.
 *
 *  resourceLimits below bounds the worker's V8 OLD-GENERATION heap only: pdfjs's big
 *  allocations are typed-array/ArrayBuffer backing stores, which are EXTERNAL memory the V8
 *  heap limit does not cover — so this is NOT a process-RSS bound and is never claimed as
 *  one. The actual hard bounds here are the 10 MB input cap (caller's), the page cap
 *  (worker's), the wall-clock watchdog (terminate reclaims the thread), and the concurrency
 *  cap (at most two such spikes at once). */
export async function extractPdfText(
  data: Uint8Array,
  opts?: { timeoutMs?: number; queueTimeoutMs?: number },
): Promise<PdfParseOutcome> {
  const timeoutMs = opts?.timeoutMs ?? PDF_PARSE_TIMEOUT_MS
  if (!(await acquirePdfSlot(opts?.queueTimeoutMs ?? PDF_PARSE_QUEUE_TIMEOUT_MS))) {
    return { kind: 'busy' }
  }
  let worker: Worker
    try {
      worker = new Worker(WORKER_PATH, {
        workerData: { data },
        // 10 MB in, and a heap ceiling that lets pdfjs work while keeping a runaway document
        // from growing the JS heap without limit. External (ArrayBuffer) memory is NOT covered
        // — see the header comment.
        resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
      })
    } catch {
      // `new Worker(...)` can throw SYNCHRONOUSLY (ERR_WORKER_INIT_FAILED under thread or
      // memory pressure) — the slot is ours to give back on that path.
      releasePdfSlot()
      return { kind: 'unreadable' }
    }
    try {
      return await new Promise<PdfParseOutcome>((resolve) => {
        let settled = false
        const finish = (outcome: PdfParseOutcome) => {
          if (settled) return
          settled = true
          clearTimeout(watchdog)
          void worker.terminate()
          resolve(outcome)
        }
        const watchdog = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
        worker.once('message', (m: { text?: string | null }) => {
          finish(typeof m?.text === 'string' && m.text ? { kind: 'text', text: m.text } : { kind: 'unreadable' })
        })
        worker.once('error', () => finish({ kind: 'unreadable' }))
        // An exit with no message means the worker died before posting (OOM at its own heap
        // ceiling reports as an exit code, not necessarily an 'error' event). finish() is a
        // no-op once a message settled, so classifying EVERY exit as unreadable is safe -
        // and a clean-but-silent exit is reported promptly instead of waiting out the watchdog.
        worker.once('exit', () => finish({ kind: 'unreadable' }))
      })
    } finally {
      releasePdfSlot()
    }
}
