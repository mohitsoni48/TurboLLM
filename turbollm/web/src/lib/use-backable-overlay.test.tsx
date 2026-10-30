// Several overlays at once under useBackableOverlay: one Back closes the top one only, a close from
// code closes nothing else, and an overlay closing as another opens (Discover's Import from URL
// opening a repo's sheet on a phone) leaves the new one open, with one history entry per open
// overlay so the next Back closes the next overlay or reaches the page.
import { StrictMode, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useBackableOverlay } from './use-backable-overlay'

function Overlay({ name, open, onClose }: { name: string; open: boolean; onClose: () => void }) {
  useBackableOverlay(open, onClose)
  return open ? <p>{name} is open</p> : null
}

/** Two overlays, B before A in the tree as Discover's repo sheet sits before its Import dialog, so
 *  B's effects run first in a commit that changes both. */
function Harness({ withA = true }: { withA?: boolean }) {
  const [a, setA] = useState(false)
  const [b, setB] = useState(false)
  return (
    <>
      <Overlay name="B" open={b} onClose={() => setB(false)} />
      {withA && <Overlay name="A" open={a} onClose={() => setA(false)} />}
      <button onClick={() => setA(true)}>open A</button>
      <button onClick={() => setB(true)}>open B</button>
      <button onClick={() => setA(false)}>close A</button>
      <button onClick={() => setB(false)}>close B</button>
      <button onClick={() => { setA(false); setB(true) }}>close A, open B</button>
      <button onClick={() => { setA(false); setB(false) }}>close both</button>
    </>
  )
}

/** jsdom traverses history a few timer tasks after back()/go(), and the hook may start another
 *  traversal from the popstate that fires: wait until no popstate has come for 100 ms, rather
 *  than a fixed delay a stall on a loaded machine could outlast. */
async function settle() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        const done = () => {
          window.removeEventListener('popstate', onPop)
          resolve()
        }
        let quiet = setTimeout(done, 100)
        function onPop() {
          clearTimeout(quiet)
          quiet = setTimeout(done, 100)
        }
        window.addEventListener('popstate', onPop)
      }),
  )
}

async function pressBack() {
  await act(async () => { history.back() })
  await settle()
}

let page = 0
/** Each test starts on a page entry of its own, so where the history ends up is checkable. */
function atPage() {
  return (history.state as { page?: number } | null)?.page === page
}

beforeEach(async () => {
  await settle()
  page += 1
  history.pushState({ page }, '')
})

const isOpen = (name: string) => screen.queryByText(`${name} is open`) !== null

describe('useBackableOverlay with several overlays', () => {
  it('keeps an overlay opened as another closes in the same update, and one Back closes it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('open A'))
    await settle()
    await user.click(screen.getByText('close A, open B'))
    await settle()
    expect(isOpen('A')).toBe(false)
    expect(isOpen('B')).toBe(true)
    expect(atPage()).toBe(false)

    await pressBack()
    expect(isOpen('B')).toBe(false)
    expect(atPage()).toBe(true)
  })

  it('leaves the overlay beneath open when the top one is closed from code', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('open A'))
    await settle()
    await user.click(screen.getByText('open B'))
    await settle()
    await user.click(screen.getByText('close B'))
    await settle()
    expect(isOpen('B')).toBe(false)
    expect(isOpen('A')).toBe(true)

    await pressBack()
    expect(isOpen('A')).toBe(false)
    expect(atPage()).toBe(true)
  })

  it('closes only the top overlay on Back, and the next one on a second Back', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('open A'))
    await settle()
    await user.click(screen.getByText('open B'))
    await settle()

    await pressBack()
    expect(isOpen('B')).toBe(false)
    expect(isOpen('A')).toBe(true)
    expect(atPage()).toBe(false)

    await pressBack()
    expect(isOpen('A')).toBe(false)
    expect(atPage()).toBe(true)
  })

  it('keeps an overlay opened while a close is still going back, and Back closes it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('open A'))
    await settle()
    fireEvent.click(screen.getByText('close A'))
    await act(async () => {})
    // Still on A's entry: the history traversal that drops it has not run yet.
    expect(atPage()).toBe(false)
    fireEvent.click(screen.getByText('open B'))
    await settle()
    expect(isOpen('B')).toBe(true)
    expect(atPage()).toBe(false)

    await pressBack()
    expect(isOpen('B')).toBe(false)
    expect(atPage()).toBe(true)
  })

  it('drops both entries when two overlays close in the same update', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('open A'))
    await settle()
    await user.click(screen.getByText('open B'))
    await settle()
    await user.click(screen.getByText('close both'))
    await settle()
    expect(isOpen('A')).toBe(false)
    expect(isOpen('B')).toBe(false)
    expect(atPage()).toBe(true)
  })

  it('holds one entry for an overlay mounted open under StrictMode', async () => {
    render(
      <StrictMode>
        <Overlay name="A" open onClose={() => {}} />
      </StrictMode>,
    )
    await settle()
    expect(atPage()).toBe(false)

    await pressBack()
    expect(atPage()).toBe(true)
  })

  it('leaves a navigation made over an open overlay alone when that overlay unmounts', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness />)
    await user.click(screen.getByText('open A'))
    await settle()
    // What a router Link does: push an entry of its own over the overlay's.
    history.pushState({ route: 'elsewhere' }, '')
    rerender(<Harness withA={false} />)
    await settle()
    expect((history.state as { route?: string } | null)?.route).toBe('elsewhere')
  })
})
