// The actual PDF parse for fetch_url, run ONLY inside the pdf-text worker thread (see
// pdf-text.ts for why the daemon's main thread never does this). Kept in its own module so
// the worker can pull it in through a computed same-directory URL — a freshly spawned
// worker_threads Worker does not reliably inherit tsx's loader hook for nested `.js`-specifier
// resolution (confirmed live on Linux CI for run-code-sandbox; same failure shape applies
// here), so resolution must depend only on a real file existing beside the worker entry, in
// dev/tsx (.ts) and the built package (.js) alike. tsup.config.ts gives this file its own
// build entry for exactly that reason.
//
// Nothing in here may touch the network, the filesystem, or the daemon's state: bytes in,
// text out.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** Pages read before stopping. fetch_url's own character ceiling applies to the result, so
 *  this only bounds pdfjs work on a hostile or enormous file. */
export const PDF_MAX_PAGES = 40

/** The text of the first PDF_MAX_PAGES pages, or null when the bytes are not a readable PDF
 *  (truncated by the byte cap, encrypted, corrupt, not a PDF at all). Never throws: a tool
 *  result must stay a string the model can use. */
export async function parsePdfText(data: Uint8Array): Promise<string | null> {
  try {
    const loadingTask = getDocument({
      data,
      useWorkerFetch: false,
      isEvalSupported: false,
      // A fetch_url reply is one-shot: no caching, no worker, no fonts fetched.
      disableFontFace: true,
      // No console output from pdfjs: warnings about fonts/canvas would land in the daemon log.
      verbosity: 0,
    } as Parameters<typeof getDocument>[0])
    const doc = await loadingTask.promise
    try {
      const pages = Math.min(doc.numPages, PDF_MAX_PAGES)
      const parts: string[] = []
      for (let p = 1; p <= pages; p++) {
        const page = await doc.getPage(p)
        const tc = await page.getTextContent()
        parts.push(
          (tc.items as Array<{ str?: string }>)
            .map((i) => (typeof i.str === 'string' ? i.str : ''))
            .join(' ')
            .trim(),
        )
      }
      const text = parts.filter(Boolean).join('\n').trim()
      return text || null
    } finally {
      await loadingTask.destroy()
    }
  } catch {
    return null
  }
}
