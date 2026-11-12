import type { InfiniteData } from '@tanstack/react-query'

/** Every query below starts from "no cursor yet". */
export const FIRST_PAGE = null as string | null

/** TanStack's `getNextPageParam`: the page's own cursor, or undefined — "no more pages" — when it has none. */
export function nextCursorOf(page: { nextCursor: string | null }): string | undefined {
  return page.nextCursor ?? undefined
}

/** The loaded pages as one list, each row once. A refresh re-reads every loaded page in order, so a row that
 *  slid across a page boundary between two reads can sit in both; the first copy wins to keep the order. */
export function flattenPages<T extends { id: string }>(data: InfiniteData<{ items: T[] }>): T[] {
  const seen = new Set<string>()
  const rows: T[] = []
  for (const page of data.pages) {
    for (const row of page.items) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }
  }
  return rows
}
