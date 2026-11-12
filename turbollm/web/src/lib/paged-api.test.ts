// Cursor paging on the three list endpoints the daemon now pages (conversations, memory facts, routine runs).
// Mocked at the browser boundary (fetch), so these pin the wire contract the UI depends on: which query
// parameter carries the cursor, and where the next cursor comes back (a body field, or X-Next-Cursor for runs).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listConversations, listMemoryFacts } from './chat-api'
import { listRoutineRuns, listRoutineRunsPage } from './routine-api'

const urls: string[] = []
function reply(body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
  }))
}

beforeEach(() => { urls.length = 0 })
afterEach(() => { vi.unstubAllGlobals() })

describe('listConversations', () => {
  it('asks for the first page with no query string', async () => {
    reply({ conversations: [], nextCursor: null })
    await listConversations()
    expect(urls).toEqual(['/api/v1/conversations'])
  })

  it('sends the cursor it was given, URL-encoded', async () => {
    reply({ conversations: [], nextCursor: null })
    await listConversations(undefined, 'a b/c')
    expect(urls).toEqual(['/api/v1/conversations?cursor=a%20b%2Fc'])
  })

  it('searches without a cursor (search is never paged)', async () => {
    reply({ conversations: [], nextCursor: null })
    await listConversations('cats', 'ignored')
    expect(urls).toEqual(['/api/v1/conversations?q=cats'])
  })

  it('returns the next cursor from the body', async () => {
    reply({ conversations: [], nextCursor: 'n1' })
    expect((await listConversations()).nextCursor).toBe('n1')
  })
})

describe('listMemoryFacts', () => {
  it('pages by cursor', async () => {
    reply({ facts: [], nextCursor: 'm2' })
    const page = await listMemoryFacts('m1')
    expect(urls).toEqual(['/api/v1/memory?cursor=m1'])
    expect(page.nextCursor).toBe('m2')
  })

  it('asks for the first page with no query string', async () => {
    reply({ facts: [], nextCursor: null })
    await listMemoryFacts()
    expect(urls).toEqual(['/api/v1/memory'])
  })
})

describe('routine runs', () => {
  const run = { id: 'r1' }

  it('listRoutineRunsPage reads the next cursor from X-Next-Cursor and sends it back as ?before', async () => {
    reply([run], { 'X-Next-Cursor': 'older1' })
    const first = await listRoutineRunsPage('rt 1')
    expect(urls[0]).toBe('/api/v1/routines/rt%201/runs')
    expect(first).toEqual({ runs: [run], nextCursor: 'older1' })

    reply([run])
    const second = await listRoutineRunsPage('rt 1', 'older1')
    expect(urls[1]).toBe('/api/v1/routines/rt%201/runs?before=older1')
    expect(second.nextCursor).toBeNull()
  })

  it('listRoutineRuns stays a plain array and can ask for just the newest few', async () => {
    reply([run])
    expect(await listRoutineRuns('rt', 1)).toEqual([run])
    expect(urls).toEqual(['/api/v1/routines/rt/runs?limit=1'])
  })
})
