import { useEffect, useRef } from 'react'
import { Button } from './ui/button'

interface LoadMoreProps {
  /** What the button says while idle: "Load more", "Load older runs". */
  label: string
  onLoadMore: () => void
  /** A page is on its way: the button is disabled and reads "Loading…". */
  loading: boolean
  /** Also load by itself once the button scrolls into view (infinite scroll). The button stays as the
   *  fallback where IntersectionObserver is missing, and for anyone who would rather click. */
  auto?: boolean
}

/** The one control every paged list ends with. The user always has the button; `auto` adds scrolling. */
export function LoadMore({ label, onLoadMore, loading, auto = false }: LoadMoreProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const onLoadMoreRef = useRef(onLoadMore)
  onLoadMoreRef.current = onLoadMore

  // Watching starts anew each time a page lands (loading goes false): an observer reports the button's
  // visibility as soon as it starts watching, so a page too short to push the button out of view keeps
  // loading until it does, or the list ends. While a page is loading nothing is watched, so one scroll
  // cannot ask twice.
  useEffect(() => {
    const el = ref.current
    if (!auto || loading || !el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [auto, loading])

  return (
    <Button ref={ref} variant="ghost" size="sm" className="w-full text-muted" onClick={onLoadMore} disabled={loading}>
      {loading ? 'Loading…' : label}
    </Button>
  )
}
