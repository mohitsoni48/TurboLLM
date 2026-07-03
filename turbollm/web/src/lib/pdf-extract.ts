// Client-side PDF text extraction for chat attachments (GitHub issue #35).
//
// Uses pdfjs-dist (Mozilla's pure JS/WASM PDF.js) so extraction runs entirely
// in the browser — no native binaries, no postinstall build step, works the
// same on Windows/macOS/Linux. The worker script is resolved via Vite's `?url`
// import so it's bundled as a static asset and resolves correctly in both dev
// and production builds.
import * as pdfjsLib from 'pdfjs-dist'
// eslint-disable-next-line import/no-unresolved -- Vite `?url` asset import
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** Extracts plain text from a PDF file, page by page, joined with blank lines. */
export async function extractPdfText(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const doc = await pdfjsLib.getDocument({ data: buf }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map((it) => ('str' in it ? it.str : '')).join(' ')
    pages.push(text)
  }
  return pages.join('\n\n')
}
