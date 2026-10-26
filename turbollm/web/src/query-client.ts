import { QueryClient } from '@tanstack/react-query'

/** The app's one QueryClient (main.tsx).
 *
 *  `networkMode: 'always'` for queries and mutations: the daemon is this app's own server, on
 *  loopback (or the machine the page was opened from), so whether the browser thinks it is online
 *  says nothing about reaching it. With React Query's default ('online') every query and mutation
 *  paused while `navigator.onLine` was false: a laptop with Wi-Fi off fired `offline`, and a chat
 *  message sent then and its streamed reply vanished until `online`, a Resume or Load did nothing,
 *  and every poll stopped, although the daemon answered all along. A request that really cannot
 *  reach the daemon now fails at once, as it does online (`retry: false`), instead of waiting
 *  silently. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, networkMode: 'always' },
      mutations: { networkMode: 'always' },
    },
  })
}
