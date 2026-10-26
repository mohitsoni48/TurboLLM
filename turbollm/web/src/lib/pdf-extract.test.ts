// extractPdfText must destroy pdf.js's loading task: each getDocument() spawns a dedicated Web
// Worker that only `PDFDocumentLoadingTask.destroy()` terminates, so skipping it leaked one worker
// (plus the parsed document) per attached PDF — on the error path too.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pdf = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
  promise: null as Promise<unknown> | null,
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: pdf.promise, destroy: pdf.destroy }),
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))

import { extractPdfText } from './pdf-extract'

const file = () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as File

describe('extractPdfText', () => {
  beforeEach(() => {
    pdf.destroy.mockClear()
  })

  it('extracts every page, then destroys the loading task (terminating its worker)', async () => {
    const page = (s: string) => ({ getTextContent: async () => ({ items: [{ str: s }, { str: 'x' }] }) })
    pdf.promise = Promise.resolve({ numPages: 2, getPage: async (i: number) => page(`p${i}`) })
    await expect(extractPdfText(file())).resolves.toBe('p1 x\n\np2 x')
    expect(pdf.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the loading task when the PDF fails to parse', async () => {
    pdf.promise = Promise.reject(new Error('Invalid PDF structure'))
    await expect(extractPdfText(file())).rejects.toThrow('Invalid PDF structure')
    expect(pdf.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the loading task when a page fails mid-extraction', async () => {
    pdf.promise = Promise.resolve({ numPages: 3, getPage: async () => { throw new Error('bad page') } })
    await expect(extractPdfText(file())).rejects.toThrow('bad page')
    expect(pdf.destroy).toHaveBeenCalledTimes(1)
  })
})
