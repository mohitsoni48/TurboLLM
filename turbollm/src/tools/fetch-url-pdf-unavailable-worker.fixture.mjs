// Test-only worker: reports that the PDF reader could not be loaded, the way pdf-text-worker
// does when pdfjs-dist (or its native canvas addon) is missing from an install.
import { parentPort } from 'node:worker_threads'
parentPort?.postMessage({ unavailable: true })
