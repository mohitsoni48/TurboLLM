import { useEffect, useState } from 'react'

/** True when the viewport is at or above the app's `md` breakpoint (768px) — the
 *  line where the side nav rail replaces the mobile bottom bar. Screens use it to
 *  switch between the desktop layout and a mobile-friendly one (e.g. the chat
 *  sidebar becomes an off-canvas drawer, the model table becomes stacked cards).
 *  Landscape/desktop rendering is unchanged; this only gates the mobile branch. */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktop(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}
