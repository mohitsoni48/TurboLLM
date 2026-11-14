// Entry point for the fetch_url PDF worker thread — see extractPdfText in pdf-text.ts for why
// parsing runs in a dedicated node:worker_threads Worker rather than on the daemon's main
// thread. Intentionally tiny: read the bytes out of workerData, parse, post the text (or null)
// back. No other logic belongs here.
import { parentPort, workerData } from 'node:worker_threads'

// Computed sibling import: a spawned worker cannot rely on tsx's loader hook resolving a
// `.js` specifier to the sibling `.ts` source (see pdf-text-extract.ts's header). This file's
// own extension says which sibling is real: `.ts` under tsx, `.js` in the built package.
const EXTRACT_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const EXTRACT_URL = new URL(`./pdf-text-extract${EXTRACT_EXT}`, import.meta.url)
if (!parentPort) {
  throw new Error('pdf-text-worker.ts must be run as a worker_threads Worker, not imported directly.')
}

// Loading the reader is the one step that can fail because of the INSTALL (pdfjs-dist missing,
// or its platform binary absent), not because of the document: say so, separately from a bad
// PDF, so a broken install is never reported as an unreadable file.
let parsePdfText: ((data: Uint8Array) => Promise<string | null>) | null = null
try {
  parsePdfText = (await import(EXTRACT_URL.href) as typeof import('./pdf-text-extract.js')).parsePdfText
} catch {
  parsePdfText = null
}

if (!parsePdfText) {
  parentPort.postMessage({ unavailable: true })
} else {
  const data = (workerData as { data?: unknown } | undefined)?.data
  const text = data instanceof Uint8Array ? await parsePdfText(data) : null
  parentPort.postMessage({ text })
}
