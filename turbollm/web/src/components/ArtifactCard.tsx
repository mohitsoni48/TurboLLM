import { useState, useEffect, useRef } from 'react'
import { Download, Loader2, ChevronDown, Maximize2, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../lib/utils'
import { useUiStore, resolveDark } from '../stores/ui'

// Fenced-block language → artifact MIME type
const ARTIFACT_LANGS: Record<string, string> = {
  html: 'text/html',
  svg: 'image/svg+xml',
  mermaid: 'application/vnd.mermaid',
}

/** Returns the artifact MIME type if the language tag is renderable, otherwise null. */
export function isArtifactLang(lang: string): string | null {
  return ARTIFACT_LANGS[lang.toLowerCase()] ?? null
}

/** Build a sandboxed srcdoc that reports its NATURAL content size ({w,h}). The card
 *  scales the whole iframe to fit; injects a CSP (blocks external network) and
 *  (HTML only) self-rasterizers for PNG/JPEG and GIF export. */
function buildSrcdoc(type: string, code: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`
  const resizeHtml = `<script>(function(){function r(){var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);var w=Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0);parent.postMessage({type:'tllm-size',w:w,h:h},'*')}window.addEventListener('load',r);if(document.readyState!=='loading')r();try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}})()</script>`
  const resizeSvg = `<script>(function(){function r(){var s=document.querySelector('svg');var b=s?s.getBoundingClientRect():null;var w=b?Math.ceil(b.width):Math.ceil(document.documentElement.scrollWidth);var h=b?Math.ceil(b.height):Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:'tllm-size',w:w,h:h},'*')}window.addEventListener('load',r);if(document.readyState!=='loading')r();try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}setTimeout(r,60)})()</script>`
  const norm = `<style>html,body{height:auto!important;min-height:0!important}img,svg,canvas,video{max-width:100%}</style>`
  const shot = `<script>window.addEventListener('message',function(e){if(!e.data||e.data.type!=='tllm-shot')return;try{var el=document.documentElement;var w=Math.max(el.scrollWidth,document.body?document.body.scrollWidth:0)||800;var h=Math.max(el.scrollHeight,document.body?document.body.scrollHeight:0)||600;var ser=new XMLSerializer().serializeToString(el);var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><foreignObject width="100%" height="100%">'+ser+'</foreignObject></svg>';var img=new Image();img.onload=function(){try{var c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0);parent.postMessage({type:'tllm-shot-result',png:c.toDataURL('image/png')},'*')}catch(err){parent.postMessage({type:'tllm-shot-result',png:null},'*')}};img.onerror=function(){parent.postMessage({type:'tllm-shot-result',png:null},'*')};img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}catch(err){parent.postMessage({type:'tllm-shot-result',png:null},'*')}})</script>`
  // Single still frame grabbed straight off a <canvas> (no taint, unlike foreignObject).
  const frame = `<script>window.addEventListener('message',function(e){if(!e.data||e.data.type!=='tllm-frame')return;var s=document.querySelector('canvas');if(!s){parent.postMessage({type:'tllm-frame-result',png:null},'*');return}try{parent.postMessage({type:'tllm-frame-result',png:s.toDataURL('image/png')},'*')}catch(err){parent.postMessage({type:'tllm-frame-result',png:null},'*')}})</script>`
  const gif = `<script>window.addEventListener('message',function(e){if(!e.data||e.data.type!=='tllm-gif')return;var s=document.querySelector('canvas');if(!s){parent.postMessage({type:'tllm-gif-result',frames:null},'*');return}var sw=s.width||s.clientWidth||300,sh=s.height||s.clientHeight||150;var sc=Math.min(1,480/Math.max(sw,sh));var w=Math.max(1,Math.round(sw*sc)),h=Math.max(1,Math.round(sh*sc));var t=document.createElement('canvas');t.width=w;t.height=h;var x=t.getContext('2d');var fr=[],n=0,m=24;var iv=setInterval(function(){try{x.clearRect(0,0,w,h);x.drawImage(s,0,0,w,h);fr.push(x.getImageData(0,0,w,h).data.buffer.slice(0))}catch(err){}if(++n>=m){clearInterval(iv);try{parent.postMessage({type:'tllm-gif-result',w:w,h:h,frames:fr},'*',fr)}catch(err){parent.postMessage({type:'tllm-gif-result',frames:null},'*')}}},70)})</script>`

  if (type === 'text/html') {
    const head = `${csp}\n${resizeHtml}\n${norm}\n${shot}\n${frame}\n${gif}`
    if (/<head[\s>]/i.test(code)) return code.replace(/(<head[^>]*>)/i, `$1\n${head}`)
    return `<!doctype html><html><head>${head}</head><body>${code}</body></html>`
  }
  if (type === 'image/svg+xml') {
    return `<!doctype html><html><head>${csp}${resizeSvg}<style>html,body{height:auto;margin:0}body{display:flex;justify-content:flex-start;align-items:flex-start;background:transparent}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`
  }
  return ''
}

/** Render an iframe scaled by `scale` and sized to the result, so the card hugs
 *  the content. Renders full-width to measure first; DOM shape is identical in
 *  both states (no reload). */
function FittedIframe({
  srcDoc, frameRef, naturalW, naturalH, scale, cap, ready, sandbox = 'allow-scripts',
}: {
  srcDoc: string
  frameRef: React.RefObject<HTMLIFrameElement | null>
  naturalW: number
  naturalH: number
  scale: number
  cap: number
  ready: boolean
  // 'allow-scripts' = interactive (isolated, runs JS). 'allow-same-origin' = static
  // (real browser render, NO scripts — untrusted markup can't execute).
  sandbox?: string
}) {
  const boxW = ready ? Math.round(naturalW * scale) : undefined
  const boxH = ready ? Math.round(naturalH * scale) : Math.min(naturalH, cap)
  return (
    <div className={ready ? '' : 'w-full'} style={{ width: boxW, height: boxH, overflow: 'hidden' }}>
      <iframe
        ref={frameRef}
        srcDoc={srcDoc}
        sandbox={sandbox}
        title="Artifact"
        className={cn('block border-0', ready ? '' : 'w-full')}
        style={ready
          ? { width: naturalW, height: naturalH, transform: scale !== 1 ? `scale(${scale})` : undefined, transformOrigin: 'top left' }
          : { height: naturalH }}
      />
    </div>
  )
}

// ── Image / animation export helpers ────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

/** Rasterize a self-contained SVG string to PNG or JPEG (2× for crispness). JPEG
 *  has no alpha, so a white background is painted first. */
function svgToRaster(svg: string, mime: 'image/png' | 'image/jpeg', scale = 2): Promise<Blob | null> {
  return new Promise((resolve) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight
      if (!w || !h) {
        const m = /viewBox="([^"]+)"/.exec(svg)
        const p = m ? m[1].trim().split(/\s+/).map(Number) : []
        if (p.length === 4) { w = p[2]; h = p[3] } else { w = 800; h = 600 }
      }
      const canvas = document.createElement('canvas')
      const effectiveScale = Math.max(scale, 2048 / Math.min(w, h))
      canvas.width = Math.max(1, Math.round(w * effectiveScale))
      canvas.height = Math.max(1, Math.round(h * effectiveScale))
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      if (mime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff'
      } else {
        // PNG: fill with the app's background so the export matches the current theme.
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
      }
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(effectiveScale, effectiveScale); ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      try { canvas.toBlob((b) => resolve(b), mime, 0.95) } catch { resolve(null) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Re-encode a (PNG) blob as JPEG on a white background. */
function blobToJpeg(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth || 800; c.height = img.naturalHeight || 600
      const ctx = c.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      try { c.toBlob((b) => resolve(b), 'image/jpeg', 0.95) } catch { resolve(null) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Ask the sandboxed HTML iframe to rasterize itself to a PNG blob (best-effort). */
function htmlIframeToPng(iframe: HTMLIFrameElement | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    const win = iframe?.contentWindow
    if (!win) return resolve(null)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-shot-result') return
      window.removeEventListener('message', onMsg)
      if (e.data.png && typeof e.data.png === 'string' && e.data.png.startsWith('data:')) fetch(e.data.png).then((r) => r.blob()).then(resolve).catch(() => resolve(null))
      else resolve(null)
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'tllm-shot' }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, 4000)
  })
}

/** Grab a single still frame from the iframe's <canvas> as a PNG blob (reliable for
 *  canvas content, where foreignObject rasterization would taint the canvas). */
function htmlIframeFrame(iframe: HTMLIFrameElement | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    const win = iframe?.contentWindow
    if (!win) return resolve(null)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-frame-result') return
      window.removeEventListener('message', onMsg)
      if (e.data.png && typeof e.data.png === 'string' && e.data.png.startsWith('data:')) fetch(e.data.png).then((r) => r.blob()).then(resolve).catch(() => resolve(null))
      else resolve(null)
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'tllm-frame' }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, 3000)
  })
}

/** Capture a <canvas> animation from the iframe and encode it to an animated GIF. */
function captureGif(iframe: HTMLIFrameElement | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    const win = iframe?.contentWindow
    if (!win) return resolve(null)
    const onMsg = async (e: MessageEvent) => {
      if (e.source !== win) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-gif-result') return
      window.removeEventListener('message', onMsg)
      const { w, h, frames } = e.data as { w?: number; h?: number; frames?: ArrayBuffer[] | null }
      if (!frames || !frames.length || !w || !h) return resolve(null)
      try {
        const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
        const enc = GIFEncoder()
        for (const buf of frames) {
          const data = new Uint8Array(buf)
          const palette = quantize(data, 256)
          const index = applyPalette(data, palette)
          enc.writeFrame(index, w, h, { palette, delay: 70 })
        }
        enc.finish()
        resolve(new Blob([new Uint8Array(enc.bytes())], { type: 'image/gif' }))
      } catch { resolve(null) }
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'tllm-gif' }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, 10000)
  })
}

/** Rasterize an SVG string to a PNG data URL (2048px minimum on shortest side).
 *  Returns null on failure. */
function svgToPreview(svg: string): Promise<string | null> {
  return new Promise((resolve) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight
      if (!w || !h) {
        const m = /viewBox="([^"]+)"/.exec(svg)
        const p = m ? m[1].trim().split(/\s+/).map(Number) : []
        if (p.length === 4) { w = p[2]; h = p[3] } else { w = 800; h = 600 }
      }
      const scale = Math.max(2, 2048 / Math.min(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Upscale a (PNG) blob to a data URL with the shortest side ≥ 2048px. */
function blobToScaledDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth || 800, h = img.naturalHeight || 600
      const scale = Math.max(1, 2048 / Math.min(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** App background color token (used as the capture canvas fill). */
function appBg(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
}

/** Minimal capture-only document: the raw artifact HTML with a CSP that blocks
 *  external network, no helper scripts (scripts never run in this iframe). */
function buildCaptureDoc(code: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`
  // Match buildSrcdoc's normalization EXACTLY (height:auto / min-height:0) so the static
  // render's intrinsic height equals the height the (scripted) sizer measured. Without
  // this, a `min-height:100vh` page renders taller here than naturalH and the bottom is
  // clipped. Scrollbars are hidden because the box is already sized to the full content.
  const norm = `<style>html,body{margin:0;height:auto!important;min-height:0!important}html{scrollbar-width:none}html::-webkit-scrollbar{width:0;height:0}img,svg,canvas,video{max-width:100%}</style>`
  if (/<head[\s>]/i.test(code)) return code.replace(/(<head[^>]*>)/i, `$1\n${csp}\n${norm}`)
  return `<!doctype html><html><head>${csp}${norm}</head><body>${code}</body></html>`
}

/** Style injected into html2canvas's CLONE just before rasterization. html2canvas
 *  deep-clones the document, which restarts CSS entry animations from their start
 *  frame (often opacity:0) — so without this the screenshot captures invisible
 *  content. Forcing 0s duration + forwards fill lands every element on its final
 *  keyframe synchronously. Applied in onclone (not the source doc) because only the
 *  clone is what gets rasterized. */
const CAPTURE_FREEZE_CSS =
  '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-fill-mode:forwards!important;transition:none!important}'

/** Render the HTML in an isolated, same-origin, SCRIPT-DISABLED iframe and rasterize
 *  it with html2canvas. Unlike the foreignObject trick, html2canvas performs real
 *  layout — so 100vh, position:fixed, flex and overflow render correctly. The iframe
 *  is same-origin (parent can read it) but carries no `allow-scripts`, so untrusted
 *  artifact markup cannot execute. Returns a PNG data URL, or null on failure. */
async function html2canvasCapture(code: string, vw: number, vh: number): Promise<string | null> {
  const bg = appBg()
  // FIXED viewport: vw × vh. `vh`-based heights (e.g. `height:80vh`) resolve against this
  // stable height, so the layout doesn't feed back into the element height (the live-iframe
  // failure mode that clipped the page). We then capture the FULL content height that
  // results, with windowHeight pinned to vh so html2canvas resolves vh the same way.
  const w = Math.max(320, Math.round(vw) || 800)
  const h = Math.max(200, Math.round(vh) || 600)
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.style.cssText = `position:fixed;left:-100000px;top:0;border:0;background:${bg};width:${w}px;height:${h}px;`
  frame.srcdoc = buildCaptureDoc(code)
  document.body.appendChild(frame)
  try {
    await new Promise((res) => {
      frame.onload = () => res(null)
      setTimeout(() => res(null), 4000)
    })
    const doc = frame.contentDocument
    if (!doc || !doc.body) return null
    try { if (doc.fonts?.ready) await doc.fonts.ready } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 250))
    // Full content height with vh resolved against the fixed viewport height h.
    const realH = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, h)
    // html2canvas can't rasterize `background-clip:text` (gradient-clipped text) — it paints
    // the background as a solid box behind the (transparent) glyphs. Flatten such elements to
    // their base text colour so the heading renders as plain text instead of a colour block.
    const win = doc.defaultView
    if (win) {
      doc.querySelectorAll('*').forEach((node) => {
        const el = node as HTMLElement
        const cs = win.getComputedStyle(el)
        const clip = cs.getPropertyValue('-webkit-background-clip') || cs.backgroundClip
        if (clip && clip.includes('text')) {
          el.style.setProperty('-webkit-text-fill-color', cs.color)
          el.style.color = cs.color
          el.style.background = 'none'
          el.style.setProperty('-webkit-background-clip', 'border-box')
          el.style.backgroundClip = 'border-box'
        }
      })
    }
    const scale = Math.max(2, 2048 / Math.min(w, realH))
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(doc.body, {
      width: w, height: realH, windowWidth: w, windowHeight: h,
      scale, backgroundColor: bg, useCORS: true, logging: false, scrollX: 0, scrollY: 0,
      onclone: (cloned: Document) => {
        const s = cloned.createElement('style')
        s.textContent = CAPTURE_FREEZE_CSS
        cloned.head.appendChild(s)
      },
    })
    return canvas.toDataURL('image/png')
  } catch {
    return null
  } finally {
    frame.remove()
  }
}

/** Capture an HTML artifact to a PNG data URL (2048px min on the shortest side).
 *  CSS layouts go through html2canvas (faithful); script/canvas-driven artifacts
 *  fall back to grabbing the live <canvas>, then the foreignObject screenshot. */
async function captureHtmlPreview(
  code: string, liveIframe: HTMLIFrameElement | null, vw: number, vh: number,
): Promise<string | null> {
  const scriptDriven = /<canvas[\s>]/i.test(code) && /<script[\s>]/i.test(code)
  if (!scriptDriven) {
    const url = await html2canvasCapture(code, vw, vh)
    if (url) return url
  }
  await new Promise((r) => setTimeout(r, 200))
  const blob = (await htmlIframeFrame(liveIframe)) ?? (await htmlIframeToPng(liveIframe))
  return blob ? blobToScaledDataUrl(blob) : null
}

/** Ask the daemon to render the artifact in a real headless Chrome and return a pixel-perfect
 *  PNG/JPEG blob. This is the faithful export (matches the on-screen render exactly); returns
 *  null when no system browser is available (503) or the request fails, so the caller falls
 *  back to the client-side html2canvas raster. */
async function serverScreenshot(html: string, width: number, mime: 'image/png' | 'image/jpeg'): Promise<Blob | null> {
  try {
    const res = await fetch('/api/v1/artifacts/screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, width }),
    })
    if (!res.ok) return null
    const png = await res.blob()
    if (!png || png.size === 0) return null
    return mime === 'image/jpeg' ? await blobToJpeg(png) : png
  } catch {
    return null
  }
}

/** Rasterize the EXACT on-screen frozen static iframe (same-origin, vh already frozen to px)
 *  to a PNG/JPEG blob, so the export matches what's shown. html2canvas doesn't reproduce flex
 *  MAIN-axis distribution (a `justify-content:center` column hero renders top-aligned), so we
 *  measure each such container's leading offset from the live layout and re-create it with
 *  `flex-start` + padding in the clone. Returns null if the frozen iframe isn't ready. */
async function rasterizeStaticFrozen(
  iframe: HTMLIFrameElement | null,
  dims: { w: number; h: number } | null,
  mime: 'image/png' | 'image/jpeg',
): Promise<Blob | null> {
  const doc = iframe?.contentDocument
  const win = doc?.defaultView
  if (!doc || !doc.body || !win || !dims) return null
  const tagged: Element[] = []
  let i = 0
  doc.querySelectorAll('*').forEach((el) => { el.setAttribute('data-h2cpad', String(i++)); tagged.push(el) })
  // (a) flex COLUMN containers whose justify-content centers/ends the content — html2canvas
  // top-aligns them, so re-create the leading offset with flex-start + padding-top. Only
  // column is touched: row space-between is left to html2canvas (the padding hack would
  // mis-handle it). (b) background-clip:text headings — html2canvas paints the gradient as a
  // solid box, so flatten them to their text colour.
  const pads: { id: string; pad: number }[] = []
  const clips: { id: string; color: string }[] = []
  const lhFix: { id: string; h: number }[] = []
  doc.querySelectorAll('*').forEach((el) => {
    const cs = win.getComputedStyle(el)
    const id = el.getAttribute('data-h2cpad')
    if (!id) return
    if ((cs.display === 'flex' || cs.display === 'inline-flex') && cs.flexDirection.startsWith('column')) {
      const jc = cs.justifyContent
      const first = el.firstElementChild
      if (first && jc && jc !== 'flex-start' && jc !== 'normal' && jc !== 'start') {
        const cr = el.getBoundingClientRect()
        const fr = first.getBoundingClientRect()
        const b = parseFloat(cs.borderTopWidth) || 0
        pads.push({ id, pad: Math.max(0, Math.round(fr.top - cr.top - b)) })
      }
    }
    const clip = cs.getPropertyValue('-webkit-background-clip') || cs.backgroundClip
    if (clip && clip.includes('text')) clips.push({ id, color: cs.color })
    // (c) single-line text in a vertically-padded box (buttons, pills): html2canvas mis-places
    // the baseline so the text sits too high. Re-center it with line-height = box height.
    if (el.children.length === 0 && (el.textContent || '').trim()) {
      const padT = parseFloat(cs.paddingTop) || 0
      const padB = parseFloat(cs.paddingBottom) || 0
      const fs = parseFloat(cs.fontSize) || 16
      const ch = (el as HTMLElement).clientHeight
      const contentH = ch - padT - padB
      if ((padT > 0 || padB > 0) && contentH > 0 && contentH < fs * 1.8) lhFix.push({ id, h: Math.round(ch) })
    }
  })
  try {
    const bg = appBg()
    const scale = Math.max(2, 2048 / Math.min(dims.w, dims.h))
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(doc.body, {
      width: dims.w, height: dims.h, windowWidth: dims.w, windowHeight: dims.h,
      scale, backgroundColor: bg, useCORS: true, logging: false, scrollX: 0, scrollY: 0,
      onclone: (cloned: Document) => {
        const s = cloned.createElement('style')
        s.textContent = CAPTURE_FREEZE_CSS
        cloned.head.appendChild(s)
        for (const p of pads) {
          const el = cloned.querySelector<HTMLElement>(`[data-h2cpad="${p.id}"]`)
          if (!el) continue
          el.style.justifyContent = 'flex-start'
          el.style.boxSizing = 'border-box'
          el.style.paddingTop = `${p.pad}px`
        }
        for (const c of clips) {
          const el = cloned.querySelector<HTMLElement>(`[data-h2cpad="${c.id}"]`)
          if (!el) continue
          el.style.setProperty('-webkit-text-fill-color', c.color)
          el.style.color = c.color
          el.style.background = 'none'
          el.style.setProperty('-webkit-background-clip', 'border-box')
          el.style.backgroundClip = 'border-box'
        }
        for (const x of lhFix) {
          const el = cloned.querySelector<HTMLElement>(`[data-h2cpad="${x.id}"]`)
          if (!el) continue
          el.style.paddingTop = '0px'
          el.style.paddingBottom = '0px'
          el.style.height = `${x.h}px`
          el.style.lineHeight = `${x.h}px`
          el.style.boxSizing = 'border-box'
        }
      },
    })
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, 0.95))
  } catch {
    return null
  } finally {
    tagged.forEach((el) => el.removeAttribute('data-h2cpad'))
  }
}

/** Post the preview to the vision model for quality verification.
 *  Returns true if OK or if the model doesn't support vision. */
async function verifyWithVision(dataUrl: string): Promise<boolean> {
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'Does this diagram or UI render correctly with no visual errors or garbled content? Reply only "ok" or briefly describe any issue.' },
        ]}],
        max_tokens: 30,
        stream: false,
      }),
    })
    if (!res.ok) return true
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const text = (data.choices?.[0]?.message?.content ?? 'ok').toLowerCase().trim()
    return text.startsWith('ok') || text.length <= 2
  } catch {
    return true
  }
}

const DEFAULT_H = 200
const MIN_CARD_W = 300
const SETTLE_MS = 350

/** Cap the preview to ~60% of the visible screen height. */
function screenCap(): number {
  const v = typeof window !== 'undefined' ? window.innerHeight : 800
  return Math.max(200, Math.round((v * 0.6) / 10) * 10)
}

/** The viewport HEIGHT to render an HTML artifact at when capturing its static image.
 *  Emulates a real desktop (1280×800 → 16:10) scaled to the capture width, so `vh`-based
 *  sections resolve to natural proportions — same idea as the fixed device viewport used
 *  for post mockups. */
function captureViewportH(vw: number): number {
  return Math.max(480, Math.round(vw * (800 / 1280)))
}

/** Width to render/measure the static HTML preview at — a stable desktop width (clamped to
 *  the available column, capped at 1280) so the responsive layout is consistent regardless of
 *  the card's current scaled width. */
function staticMeasureW(availW: number): number {
  return Math.max(360, Math.min(Math.round(availW) || 1000, 1280))
}

/** Rewrite viewport-HEIGHT units (vh/dvh/svh/lvh) to fixed px against a reference viewport
 *  height, in a (same-origin) artifact document's stylesheets + inline styles. After this,
 *  the page's layout no longer depends on the iframe's own height — so the iframe can be
 *  sized to the full content height without a `height:80vh` hero feeding back and clipping
 *  the page. vw-based units are left alone (width is stable). Returns silently on cross-origin
 *  sheets. */
function freezeVh(doc: Document, refH: number): void {
  const conv = (v: string) =>
    v.replace(/(-?[\d.]+)(dvh|svh|lvh|vh)\b/gi, (_m, n) => `${(parseFloat(n) / 100) * refH}px`)
  // Rewrite the <style> TEXT (not just the live cssRules) so the value is frozen for both the
  // on-screen render AND any html2canvas clone of this doc, which copies <style> textContent.
  doc.querySelectorAll('style').forEach((s) => {
    const t = s.textContent || ''
    if (/vh\b/i.test(t)) s.textContent = conv(t)
  })
  doc.querySelectorAll<HTMLElement>('[style*="vh"]').forEach((el) => {
    el.setAttribute('style', conv(el.getAttribute('style') || ''))
  })
}

type Fmt = 'png' | 'jpeg' | 'svg' | 'gif' | 'html'
const FMT_LABEL: Record<Fmt, string> = { png: 'PNG', jpeg: 'JPEG', svg: 'SVG', gif: 'GIF', html: 'HTML' }

interface ArtifactCardProps {
  lang: string
  code: string
}

/** Renders a code artifact (HTML / SVG / Mermaid) as an IMAGE. The underlying type
 *  is intentionally hidden — no language tag, no code view — so it reads as a
 *  rendered result with applicable image-format downloads. */
export function ArtifactCard({ lang, code }: ArtifactCardProps) {
  const type = ARTIFACT_LANGS[lang.toLowerCase()] ?? 'text/html'
  const theme = useUiStore((s) => s.theme)
  // 'height' = fit within 60vh (card hugs content). 'width' = full column width.
  const [fitMode, setFitMode] = useState<'height' | 'width'>('height')
  const [naturalH, setNaturalH] = useState(DEFAULT_H)
  const [naturalW, setNaturalW] = useState(0)
  const [availW, setAvailW] = useState(0)
  const [maxH, setMaxH] = useState(screenCap)
  const [mermaid, setMermaid] = useState<{ svg?: string; error?: string; loading?: boolean }>({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const staticRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [interactive, setInteractive] = useState(false)
  // Frozen-vh dimensions of the static HTML render: once the static iframe has loaded, the
  // parent rewrites its vh units to px and measures the true full-page size here, so the
  // iframe can be shown at full height (no clip) without the height feeding back into vh.
  const [staticDims, setStaticDims] = useState<{ w: number; h: number } | null>(null)
  // Intrinsic pixel size of the captured preview image. Used to size the card in
  // static mode — Mermaid/SVG never render the sizing iframe, so without this their
  // card would fall back to full column width.
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null)

  // Debounced code (handles any re-render churn; equals code once settled).
  const [stableCode, setStableCode] = useState(code)
  useEffect(() => {
    const t = setTimeout(() => setStableCode(code), SETTLE_MS)
    return () => clearTimeout(t)
  }, [code])

  useEffect(() => {
    const onResize = () => setMaxH((prev) => { const n = screenCap(); return n === prev ? prev : n })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setAvailW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The iframe reports its NATURAL content size (scoped to THIS card). Threshold
  // updates so animated artifacts don't jitter the card.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-size') return
      const w = Number(e.data.w), h = Number(e.data.h)
      if (!isNaN(h) && h > 0) { const nh = Math.min(Math.ceil(h) + 2, 15000); setNaturalH((p) => Math.abs(nh - p) > 4 ? nh : p) }
      if (!isNaN(w) && w > 0) { const nw = Math.min(Math.ceil(w), 15000); setNaturalW((p) => Math.abs(nw - p) > 4 ? nw : p) }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Render mermaid; re-renders on app-theme change.
  useEffect(() => {
    if (type !== 'application/vnd.mermaid') return
    let cancelled = false
    void (async () => {
      setMermaid({ loading: true })
      try {
        const m = (await import('mermaid')).default
        // htmlLabels:false renders labels as native SVG <text> instead of <foreignObject>.
        // foreignObject taints the canvas when the SVG is rasterized via <img> for PNG/JPEG
        // export (Chrome SecurityError), so image downloads of mermaid artifacts fail. Native
        // <text> rasterizes cleanly. securityLevel:'strict' is the default — set explicitly.
        m.initialize({
          startOnLoad: false,
          theme: resolveDark(theme) ? 'dark' : 'default',
          suppressErrorRendering: true,
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        })
        await m.parse(stableCode)
        if (cancelled) return
        const id = `mmd${Math.random().toString(36).slice(2, 8)}`
        const { svg } = await m.render(id, stableCode)
        if (!cancelled) setMermaid({ svg })
      } catch (e) {
        if (!cancelled) setMermaid({ error: (e as Error).message })
      }
    })()
    return () => { cancelled = true }
  }, [type, stableCode, theme])

  // Computed here (before capture effects) so the effects can reference it safely.
  const fitReady = naturalW > 0 && availW > 0

  // Clear static preview whenever content or theme changes.
  useEffect(() => {
    setPreviewUrl(null)
    setInteractive(false)
    setImgDims(null)
    setStaticDims(null)
  }, [stableCode, theme])

  // Capture Mermaid SVG → static preview image once the SVG is rendered.
  useEffect(() => {
    if (type !== 'application/vnd.mermaid' || !mermaid.svg) return
    let cancelled = false
    const svg = mermaid.svg
    void svgToPreview(svg).then((url) => {
      if (cancelled || !url) return
      setPreviewUrl(url)
      void verifyWithVision(url).then((ok) => {
        if (!ok && !cancelled) void svgToPreview(svg).then((u2) => { if (u2 && !cancelled) setPreviewUrl(u2) })
      })
    })
    return () => { cancelled = true }
  }, [type, mermaid.svg])

  // Capture SVG → static preview image (perfect SVG raster). Mermaid has its own
  // capture effect; HTML renders a live browser iframe instead and only rasterizes
  // (via html2canvas) on download.
  useEffect(() => {
    if (type !== 'image/svg+xml' || !fitReady) return
    let cancelled = false
    void svgToPreview(stableCode).then((url) => {
      if (cancelled || !url) return
      setPreviewUrl(url)
      void verifyWithVision(url).then((ok) => {
        if (!ok && !cancelled) void svgToPreview(stableCode).then((u2) => { if (u2 && !cancelled) setPreviewUrl(u2) })
      })
    })
    return () => { cancelled = true }
  }, [type, fitReady, stableCode])

  // Static HTML render: freeze the live iframe's vh→px (at a desktop-proportioned reference
  // viewport) and measure the true full-page size. A LIVE iframe is pixel-perfect (flexbox
  // centering, gradients, backdrop-filter — none of which html2canvas reproduces), and
  // freezing vh lets us show the WHOLE page at full height without the `height:80vh` hero
  // feeding back into the iframe height and clipping the page. Interactive mode uses the
  // scripted iframe; this just sizes the non-interactive static view.
  useEffect(() => {
    // The static iframe is ALWAYS mounted (only its visibility toggles), so it's frozen+
    // measured exactly once per content/theme — toggling to interactive and back never
    // remounts it (a remount would load an UNFROZEN doc and clip the page).
    if (type !== 'text/html' || staticDims || !fitReady) return
    const f = staticRef.current
    if (!f) return
    let cancelled = false
    const refH = captureViewportH(staticMeasureW(availW))
    const measure = () => {
      const doc = f.contentDocument
      if (!doc || !doc.body) return
      try { freezeVh(doc, refH) } catch { /* cross-origin / parse issue: fall back to raw */ }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (cancelled || !doc.body) return
        const w = Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth)
        const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight)
        if (w > 0 && h > 0) setStaticDims({ w, h })
      }))
    }
    if (f.contentDocument?.readyState === 'complete') measure()
    f.addEventListener('load', measure)
    return () => { cancelled = true; f.removeEventListener('load', measure) }
    // availW read at call time; resizing re-runs via staticDims reset, not as a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, staticDims, fitReady, stableCode, theme])

  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const srcdoc = type !== 'application/vnd.mermaid' ? buildSrcdoc(type, stableCode) : ''
  const mermaidSrcdoc = mermaid.svg ? buildSrcdoc('image/svg+xml', mermaid.svg) : ''

  // Static shows the frozen-vh live render (HTML) or the rasterized image (Mermaid/SVG);
  // interactive shows the live scripted iframe.
  const htmlStaticReady = type === 'text/html' && !interactive && !!staticDims
  const showStatic = !interactive && (type === 'text/html' ? !!staticDims : !!previewUrl)
  // The static render's own measured pixels are authoritative for sizing the card.
  const usingImg = !interactive && type !== 'text/html' && !!imgDims
  const dispW = htmlStaticReady ? staticDims!.w : usingImg ? imgDims!.w : naturalW
  const dispH = htmlStaticReady ? staticDims!.h : usingImg ? imgDims!.h : naturalH
  const dispReady = dispW > 0 && availW > 0

  // Fit-height: scale to the 60vh cap, card hugs content. Fit-width: full column.
  const cap = maxH
  let scale = 1
  if (dispReady) {
    if (fitMode === 'width') {
      scale = availW / dispW
    } else {
      const heightScale = dispH > cap ? cap / dispH : 1
      const wAfterH = dispW * heightScale
      const widthScale = wAfterH > availW ? availW / wAfterH : 1
      scale = heightScale * widthScale
    }
  }
  const displayW = dispReady ? Math.round(dispW * scale) : 0
  // Interactive uses a full-width real viewport; static hugs the scaled design.
  const cardWidth = interactive ? '100%' : (dispReady && fitMode === 'height' ? `${displayW}px` : '100%')

  // Applicable image-format downloads — the underlying html/svg/mermaid is abstracted.
  const formats: Fmt[] = type === 'text/html' ? ['png', 'jpeg', 'gif', 'html'] : ['png', 'jpeg', 'svg']

  async function download(fmt: Fmt) {
    setMenuOpen(false)
    setBusy(true)
    try {
      if (fmt === 'svg') {
        const svg = type === 'application/vnd.mermaid' ? (mermaid.svg ?? '') : stableCode
        if (svg) downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'artifact.svg')
      } else if (fmt === 'html') {
        downloadBlob(new Blob([stableCode], { type: 'text/html' }), 'artifact.html')
      } else if (fmt === 'gif') {
        const blob = await captureGif(iframeRef.current)
        if (blob) downloadBlob(blob, 'artifact.gif')
        else {
          const png = await htmlIframeToPng(iframeRef.current)
          if (png) downloadBlob(png, 'artifact.png')
        }
      } else {
        // png | jpeg
        const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png'
        let blob: Blob | null = null
        if (type === 'application/vnd.mermaid') blob = mermaid.svg ? await svgToRaster(mermaid.svg, mime) : null
        else if (type === 'image/svg+xml') blob = await svgToRaster(stableCode, mime)
        else {
          // HTML: prefer a real headless-Chrome screenshot from the daemon (pixel-perfect,
          // matches the on-screen render). Fall back to the client-side raster of the frozen
          // static iframe when no system browser is available, then a fresh capture.
          blob = await serverScreenshot(stableCode, staticMeasureW(availW), mime)
          if (!blob) blob = await rasterizeStaticFrozen(staticRef.current, staticDims, mime)
          if (!blob) {
            const vw = staticMeasureW(availW)
            const url = await captureHtmlPreview(stableCode, iframeRef.current, vw, captureViewportH(vw))
            const png = url ? await (await fetch(url)).blob() : null
            blob = png ? (fmt === 'jpeg' ? await blobToJpeg(png) : png) : null
          }
        }
        if (blob) downloadBlob(blob, fmt === 'jpeg' ? 'artifact.jpg' : 'artifact.png')
        else toast.error('Couldn’t export this artifact as an image — try GIF or HTML.')
      }
    } finally {
      setBusy(false)
    }
  }

  // ── Body content ──────────────────────────────────────────────────────────────
  let body: React.ReactNode

  if (type === 'application/vnd.mermaid' && mermaid.error) {
    body = (
      <div className="flex items-center justify-center px-3 py-6 text-[12px] text-muted" style={{ minHeight: 100 }}>
        This artifact couldn&apos;t be rendered.
      </div>
    )
  } else if (type === 'application/vnd.mermaid' && (mermaid.loading || !mermaid.svg)) {
    body = (
      <div className="flex items-center justify-center" style={{ minHeight: 120 }}>
        <div className="flex items-center gap-2 text-faint">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-[13px]">Rendering artifact…</span>
        </div>
      </div>
    )
  } else if (type === 'text/html') {
    //  · static (default): the LIVE page rendered in a same-origin, no-scripts iframe with its
    //    `vh` units frozen to px (see the static-measure effect). A live render is pixel-perfect
    //    — flexbox centering, gradients, backdrop-filter — none of which a rasterizer reproduces;
    //    freezing vh lets it show at full height with no clip and no feedback. `pointer-events:
    //    none` makes it non-interactive. Until measured we render it transparent + a spinner.
    //  · interactive: a REAL viewport — scale 1, full card width, fixed 60vh height, natively
    //    scrollable, scripts on. Fixed height = no collapse / no runaway-expand.
    // A hidden scripted iframe (iframeRef) powers GIF/canvas + on-demand image downloads.
    const measureW = staticMeasureW(availW)
    const refH = captureViewportH(measureW)
    body = (
      <>
        <div style={{ height: 0, overflow: 'hidden' }} aria-hidden>
          <FittedIframe frameRef={iframeRef} srcDoc={srcdoc} naturalW={naturalW} naturalH={naturalH} scale={scale} cap={cap} ready={fitReady} />
        </div>
        {/* Static frozen-vh render — ALWAYS mounted (frozen once); only hidden when interactive,
            so toggling back never remounts/unfreezes it. */}
        <div
          style={interactive
            ? { height: 0, overflow: 'hidden' }
            : {
                position: 'relative',
                width: staticDims ? Math.round(staticDims.w * scale) : undefined,
                height: staticDims ? Math.round(staticDims.h * scale) : undefined,
                overflow: 'hidden',
              }}
          aria-hidden={interactive}
        >
          <iframe
            ref={staticRef}
            srcDoc={buildCaptureDoc(stableCode)}
            sandbox="allow-same-origin"
            title="Artifact"
            scrolling="no"
            className="block border-0"
            style={staticDims
              ? { width: staticDims.w, height: staticDims.h, transform: scale !== 1 ? `scale(${scale})` : undefined, transformOrigin: 'top left', pointerEvents: 'none' }
              : { width: measureW, height: refH, pointerEvents: 'none', opacity: 0 }}
          />
          {!interactive && !staticDims && (
            <div className="flex items-center justify-center" style={{ position: 'absolute', inset: 0, minHeight: 160 }}>
              <div className="flex items-center gap-2 text-faint">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-[13px]">Rendering artifact…</span>
              </div>
            </div>
          )}
        </div>
        {interactive && (
          <iframe
            srcDoc={srcdoc}
            sandbox="allow-scripts"
            title="Artifact"
            className="block w-full border-0"
            style={{ height: cap }}
          />
        )}
      </>
    )
  } else if (showStatic) {
    // Mermaid/SVG: perfect SVG-rasterized image.
    body = (
      <img
        src={previewUrl!}
        alt="Artifact"
        onLoad={(e) => {
          const el = e.currentTarget
          if (el.naturalWidth && el.naturalHeight) setImgDims({ w: el.naturalWidth, h: el.naturalHeight })
        }}
        style={{ width: cardWidth, height: 'auto', display: 'block' }}
        className="min-w-0"
      />
    )
  } else {
    // Mermaid/SVG before the image is ready: live render.
    const doc = type === 'application/vnd.mermaid' ? mermaidSrcdoc : srcdoc
    body = <FittedIframe frameRef={iframeRef} srcDoc={doc} naturalW={naturalW} naturalH={naturalH} scale={scale} cap={cap} ready={fitReady} />
  }

  return (
    // Outer container is full-width (measures availW); the card is left-aligned.
    <div ref={containerRef} className="my-2 flex justify-start">
      <div
        className="overflow-hidden rounded-lg border border-border"
        style={{ width: cardWidth, minWidth: 'min(100%, ' + MIN_CARD_W + 'px)' }}
      >
        {/* Header — no type tag, no code toggle; just view + download controls */}
        <div className="flex items-center justify-between border-b border-border bg-panel-2 px-3 py-1">
          <span className="text-[11px] text-faint">Artifact</span>
          <div className="flex items-center gap-0.5">
            {/* Static (real no-JS render) ↔ Interactive (scripted) toggle — HTML only */}
            {type === 'text/html' && (
              <button
                type="button"
                onClick={() => setInteractive((v) => !v)}
                title={interactive ? 'Switch to static render' : 'Switch to interactive mode'}
                className="rounded px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:text-ink"
              >
                {interactive ? 'Static' : 'Interactive'}
              </button>
            )}
            <button
              type="button"
              title={fitMode === 'height' ? 'Expand to full width' : 'Fit to screen height'}
              onClick={() => setFitMode((m) => (m === 'height' ? 'width' : 'height'))}
              className="rounded p-1 text-faint transition-colors hover:text-ink"
            >
              {fitMode === 'height' ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
            </button>
            <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                title="Download"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex items-center rounded p-1 text-faint transition-colors hover:text-ink"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                <ChevronDown size={9} className="ml-0.5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 z-10 mt-1 min-w-28 overflow-hidden rounded-md border border-border bg-panel shadow-lg">
                  {formats.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => void download(f)}
                      className="block w-full px-3 py-1.5 text-left text-[12px] text-muted hover:bg-panel-2 hover:text-ink"
                    >
                      {FMT_LABEL[f]}
                      {f === 'gif' && <span className="ml-1 text-[10px] text-faint">animation</span>}
                      {f === 'html' && <span className="ml-1 text-[10px] text-faint">source</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        {body}
      </div>
    </div>
  )
}
