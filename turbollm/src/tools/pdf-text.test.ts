import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractPdfText } from './pdf-text'

// A bundle that does not ship the worker file (the Android build) raises a module-not-found error from the Worker; the
// model must hear that the reader is missing, not that the document may be a scan or corrupt. No PDF parsing runs here,
// so this needs neither pdfjs-dist nor its native canvas addon.
test('extractPdfText: a worker file missing from the install reports unavailable, not an unreadable document', async () => {
  const missing = new URL('./no-such-pdf-worker.js', import.meta.url)
  assert.deepEqual(await extractPdfText(new Uint8Array([1, 2, 3, 4]), { workerPath: missing }), { kind: 'unavailable' })
})
