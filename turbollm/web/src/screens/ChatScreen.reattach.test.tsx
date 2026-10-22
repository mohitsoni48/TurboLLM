// A chat reply runs in the daemon, whatever page started it: the page only follows it. So a page opened, reloaded or
// switched back to while a reply runs (on this device or another) attaches to it and shows it live with Stop; a
// dropped connection resumes by GET and never sends the message again; Stop names the reply and is what stops it.
// Renders the REAL screen with the REAL sidebar, conversation queries and chat client; the daemon is stubbed at the
// fetch boundary with real SSE bodies (the other data hooks are stubbed at theirs, as in ChatScreen.streaming.test.tsx).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BrowserRouter, MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from '../components/ui/sonner'

// Rendering the real screen takes several seconds on a loaded box (as ChatScreen.remote-token.test.tsx says).
vi.setConfig({ testTimeout: 30_000 })

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' }, model: { key: 'm1', name: 'M1', ctx: 8192 } } }),
    useModels: () => ({ data: { models: [{ key: 'm1', name: 'M1', compatibleWithActiveEngine: true }] } }),
    useModelActions: () => ({ load: { mutate: vi.fn(), isPending: false }, eject: { mutate: vi.fn(), isPending: false } }),
    useModelDetail: () => ({ data: undefined }),
    useEngines: () => ({ data: undefined }),
    useSettings: () => ({ query: { data: undefined } }),
    useSysInfo: () => ({ data: undefined }),
    useChatAgents: () => ({ data: [] }),
    useBuiltinAgentOverrides: () => ({ data: {} }),
  }
})
vi.mock('../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/link-queries')>()
  return { ...actual, useLinks: () => ({ data: [] }), useRemoteModels: () => ({ data: [] }), useLinkStatus: () => ({ data: undefined }) }
})
vi.mock('../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve([]) }
})
// A phone's layout (the conversation drawer) where a test says so.
const layout = vi.hoisted(() => ({ desktop: true }))
vi.mock('../lib/useIsDesktop', () => ({ useIsDesktop: () => layout.desktop }))
vi.mock('../lib/pdf-extract', () => ({ extractPdfText: vi.fn() }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))
vi.mock('../components/ModelLoadMenu', () => ({ ModelLoadMenu: () => null }))

// ── the daemon, at the fetch boundary ──────────────────────────────────────────────────────────────────────────────

type Wire = { id?: number; event: string; data: unknown }
const enc = new TextEncoder()
const wire = (f: Wire) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n${f.id !== undefined ? `id: ${f.id}\n` : ''}\n`
const settle = () => new Promise((r) => setTimeout(r, 20))

/** One SSE response the test writes frames into as the daemon would, until it ends, drops or the page aborts it. */
function liveStream() {
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined
  const early: string[] = []
  let aborted = false
  const respond = (signal?: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
      for (const t of early) c.enqueue(enc.encode(t))
      signal?.addEventListener('abort', () => { aborted = true; try { c.error(new DOMException('The operation was aborted.', 'AbortError')) } catch { /* closed */ } })
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  return {
    respond,
    aborted: () => aborted,
    push: async (...frames: Wire[]) => {
      await act(async () => {
        for (const f of frames) { if (ctl) ctl.enqueue(enc.encode(wire(f))); else early.push(wire(f)) }
        await settle()
      })
    },
    end: () => act(async () => { ctl?.close(); await settle() }),
    drop: () => act(async () => { ctl?.error(new TypeError('network error')); await settle() }),
  }
}
type Stream = ReturnType<typeof liveStream>

/** A POST the daemon has not answered yet: it answers with `s` once the test says so, and fails as fetch does if the
 *  page aborts it first. */
function heldPost() {
  let answer!: (s: Stream) => void
  const answered = new Promise<Stream>((r) => { answer = r })
  let aborted = false
  return {
    aborted: () => aborted,
    answer: (s: Stream) => act(async () => { answer(s); await settle() }),
    respond: (signal?: AbortSignal) => new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('The operation was aborted.', 'AbortError')) })
      void answered.then((s) => resolve(s.respond(signal)))
    }),
  }
}
type HeldPost = ReturnType<typeof heldPost>

function message(id: string, seq: number, role: 'user' | 'assistant', content: string, stats: Record<string, unknown> = {}) {
  return { id, convId: 'c1', seq, role, content, reasoning: '', attachments: [], textAttachments: [], toolCalls: [], stats, createdAt: '', variantGroup: null, isActive: true, edited: false }
}
const now = new Date().toISOString()
function conversation(id: string, messages: unknown[], runningReplyId: string | null) {
  return { id, title: `Chat ${id}`, systemPrompt: '', modelKey: 'm1', sampling: {}, expertMode: false, preserveThinking: true, skillIds: [], createdAt: now, updatedAt: now, folderId: null, messages, runningReplyId, compacting: false }
}

/** GET /api/v1/conversations/:id, as the daemon would answer it now. */
const details = new Map<string, ReturnType<typeof conversation>>()
/** The list's `running` per chat. */
let running: Record<string, boolean> = {}
/** Held GET /conversations/:id answers (the test releases them), while set. */
let holdDetail: Promise<void> | null = null
/** The next answers to GET .../stream and POST .../messages, in order. An unqueued stream GET gets an empty stream. */
let streams: Stream[] = []
let posts: Array<Stream | Response | HeldPost> = []
/** POST /api/v1/chat/stop's answers, in order (then `{ ok: true, stopped: true }`). */
let stopAnswers: Response[] = []
/** The id POST /api/v1/conversations gives the next chat it creates. */
let nextChatId = 'c9'
const calls: Array<{ method: string; url: string; body?: unknown }> = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, writable: true, value: () => {} })
  details.clear()
  running = {}
  holdDetail = null
  streams = []
  posts = []
  stopAnswers = []
  nextChatId = 'c9'
  layout.desktop = true
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const path = url.split('?')[0]
    if (method === 'GET' && path === '/api/v1/conversations') {
      return json({ conversations: [...details.values()].map(({ messages: _m, runningReplyId: _r, compacting: _c, ...row }) => ({ ...row, running: !!running[row.id] })) })
    }
    if (method === 'GET' && path === '/api/v1/folders') return json({ folders: [] })
    if (method === 'POST' && path === '/api/v1/conversations') {
      const created = conversation(nextChatId, [], null)
      details.set(created.id, created)
      return json(created, 201)
    }
    let m = /^\/api\/v1\/conversations\/([^/]+)\/stream$/.exec(path)
    if (method === 'GET' && m) {
      const next = streams.shift()
      if (next) return next.respond(init?.signal ?? undefined)
      return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    m = /^\/api\/v1\/conversations\/([^/]+)\/messages$/.exec(path)
    if (method === 'POST' && m) {
      const next = posts.shift()
      if (!next) throw new Error('unexpected POST')
      return next instanceof Response ? next : next.respond(init?.signal ?? undefined)
    }
    m = /^\/api\/v1\/conversations\/([^/]+)$/.exec(path)
    if (method === 'GET' && m) {
      await holdDetail
      const d = details.get(decodeURIComponent(m[1]))
      return d ? json(d) : json({ error: { code: 'not_found', message: 'Conversation not found.' } }, 404)
    }
    if (method === 'POST' && path === '/api/v1/chat/stop') return stopAnswers.shift() ?? json({ ok: true, stopped: true })
    if (method === 'POST' && /\/tool-calls\/[^/]+\/approve$/.test(path)) return json({ ok: true })
    return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

let navigate: NavigateFunction
function NavProbe() {
  navigate = useNavigate()
  return null
}

async function renderScreen(path: string) {
  const { ChatScreen } = await import('./ChatScreen')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <NavProbe />
        <Routes>
          <Route path="/chat/:convId" element={<ChatScreen />} />
          <Route path="/chat" element={<ChatScreen />} />
          <Route path="/models" element={<p>Models screen</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  /** The next 4 s poll of the open chat, now. */
  const poll = () => act(async () => { await qc.refetchQueries({ queryKey: ['conversation'] }); await settle() })
  return { ...view, qc, poll }
}

/** The screen in the app's own router (main.tsx's BrowserRouter) over jsdom's history, at its current address. */
async function renderInBrowser() {
  const { ChatScreen } = await import('./ChatScreen')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <NavProbe />
        <Routes>
          <Route path="/workspace/chat" element={<ChatScreen />} />
          <Route path="/workspace/chat/:convId" element={<ChatScreen />} />
          <Route path="/models" element={<p>Models screen</p>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  )
  const poll = () => act(async () => { await qc.refetchQueries({ queryKey: ['conversation'] }); await settle() })
  return { ...view, qc, poll }
}

/** jsdom traverses history a few timer tasks after back(), and use-backable-overlay.ts may start another traversal from
 *  the popstate that fires: waits until no popstate has come for 100 ms (as use-backable-overlay.test.tsx does). */
async function historySettled() {
  await act(() => new Promise<void>((resolve) => {
    const done = () => { window.removeEventListener('popstate', onPop); resolve() }
    let quiet = setTimeout(done, 100)
    function onPop() { clearTimeout(quiet); quiet = setTimeout(done, 100) }
    window.addEventListener('popstate', onPop)
  }))
}
async function pressBack() {
  await act(async () => { history.back() })
  await historySettled()
}

const streamGets = () => calls.filter((c) => c.method === 'GET' && c.url.includes('/stream'))
const postsSent = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))
const stopButton = () => screen.queryByTitle('Stop generation (Esc)')
const metaOf = (reply: string, seq?: number): Wire => ({ id: seq, event: 'meta', data: { userMessageId: 'u1', assistantMessageId: reply } })
const delta = (seq: number, text: string): Wire => ({ id: seq, event: 'delta', data: { delta: text } })
const doneWith = (seq: number, saved: unknown): Wire => ({ id: seq, event: 'done', data: { message: saved } })

/** c1: a question and the placeholder of reply a1, which the daemon says is running. */
function runningChat(reply = 'a1') {
  details.set('c1', conversation('c1', [message('u1', 1, 'user', 'tell me a story'), message(reply, 2, 'assistant', '', { aborted: false })], reply))
  running.c1 = true
}

describe('ChatScreen — a reply that runs in the daemon', () => {
  it('opening a chat whose reply runs attaches to it (a plain GET), shows the text so far and Stop, then the saved reply', async () => {
    runningChat()
    const s = liveStream()
    streams = [s]
    await renderScreen('/chat/c1')
    await waitFor(() => expect(streamGets()).toHaveLength(1))
    expect(streamGets()[0].url).toBe('/api/v1/conversations/c1/stream')
    await s.push(metaOf('a1'), metaOf('a1', 0), delta(1, 'Once upon '), delta(2, 'a time'))
    expect(await screen.findByText(/Once upon a time/)).toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()

    // The daemon's done carries the reply as it saved it: that is what the bubble keeps, before any re-read.
    let release!: () => void
    holdDetail = new Promise<void>((r) => { release = r })
    await s.push(doneWith(3, message('a1', 2, 'assistant', 'Once upon a time, the end.', { aborted: false, totalMs: 900 })))
    expect(await screen.findByText(/Once upon a time, the end\./)).toBeInTheDocument()
    expect(stopButton()).toBeNull()
    release()
    expect(postsSent()).toHaveLength(0)
  })

  it('a send whose connection drops after its meta resumes by GET from its cursor, keeps the text, and sends nothing again', async () => {
    details.set('c1', conversation('c1', [message('u0', 1, 'user', 'earlier')], null))
    const first = liveStream()
    const rest = liveStream()
    posts = [first]
    streams = [rest]
    await renderScreen('/chat/c1')
    const ta = await screen.findByPlaceholderText(/^Message /)
    fireEvent.change(ta, { target: { value: 'hello?' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    details.set('c1', conversation('c1', [message('u0', 1, 'user', 'earlier'), message('u1', 2, 'user', 'hello?'), message('a1', 3, 'assistant', '', { aborted: false })], 'a1'))
    await first.push(metaOf('a1', 0), delta(1, 'Hel'), delta(2, 'lo'))
    expect(await screen.findByText(/Hello/)).toBeInTheDocument()
    await first.drop()
    await waitFor(() => expect(streamGets()).toHaveLength(1), { timeout: 3000 })
    expect(streamGets()[0].url).toBe('/api/v1/conversations/c1/stream?run=a1&fromSeq=3')
    await rest.push(delta(3, ' world'))
    expect(await screen.findByText(/Hello world/)).toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()
    expect(postsSent()).toHaveLength(1)
  })

  it('Stop names the reply and only then stops following it; a failed Stop says so and stays attached', async () => {
    runningChat()
    const s = liveStream()
    streams = [s]
    stopAnswers = [json({ error: { code: 'internal', message: 'boom' } }, 500)]
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      await s.push(metaOf('a1'), metaOf('a1', 0), delta(1, 'Half a story'))
      expect(await screen.findByText(/Half a story/)).toBeInTheDocument()

      await act(async () => { fireEvent.click(stopButton()!) })
      await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not stop the reply.'))
      expect(calls.filter((c) => c.url === '/api/v1/chat/stop').map((c) => c.body)).toEqual([{ conversationId: 'c1', messageId: 'a1' }])
      expect(s.aborted()).toBe(false)
      expect(stopButton()).toBeInTheDocument()

      // Every re-read of the chat waits while the stopped reply's row is being saved: what the bubble shows meanwhile
      // is the page's own doing.
      let release!: () => void
      holdDetail = new Promise<void>((r) => { release = r })
      await act(async () => { fireEvent.click(stopButton()!) })
      await waitFor(() => expect(stopButton()).toBeNull())
      expect(s.aborted()).toBe(true)
      // The text so far stays in the bubble (the cached reply), not the empty placeholder.
      expect(screen.getByText(/Half a story/)).toBeInTheDocument()
      await act(async () => { await new Promise((r) => setTimeout(r, 500)) })
      expect(screen.getByText(/Half a story/)).toBeInTheDocument()
      // The daemon has saved it as stopped; the read handleStop asked for lands.
      details.set('c1', conversation('c1', [message('u1', 1, 'user', 'tell me a story'), message('a1', 2, 'assistant', 'Half a story', { aborted: true, totalMs: 40 })], null))
      await act(async () => { release(); await settle() })
      expect(await screen.findByText(/Half a story/)).toBeInTheDocument()
      expect(toastError).toHaveBeenCalledTimes(1)
    } finally {
      toastError.mockRestore()
    }
  })

  it('a Stop the daemon answers stopped:false (the reply had ended) stops following and reads the chat again, with no toast', async () => {
    runningChat()
    const s = liveStream()
    streams = [s]
    stopAnswers = [json({ ok: true, stopped: false })]
    const toastError = vi.spyOn(toast, 'error')
    try {
      await renderScreen('/chat/c1')
      await s.push(metaOf('a1'), metaOf('a1', 0), delta(1, 'Nearly done'))
      expect(await screen.findByText(/Nearly done/)).toBeInTheDocument()
      details.set('c1', conversation('c1', [message('u1', 1, 'user', 'tell me a story'), message('a1', 2, 'assistant', 'Nearly done, and done.', { aborted: false, totalMs: 500 })], null))
      await act(async () => { fireEvent.click(stopButton()!) })
      expect(await screen.findByText(/Nearly done, and done\./)).toBeInTheDocument()
      expect(stopButton()).toBeNull()
      expect(s.aborted()).toBe(true)
      expect(toastError).not.toHaveBeenCalled()
    } finally {
      toastError.mockRestore()
    }
  })

  it('a call waiting for approval, replayed on attach, shows its card, and Allow answers it', async () => {
    runningChat()
    const s = liveStream()
    streams = [s]
    await renderScreen('/chat/c1')
    await s.push(
      metaOf('a1'), metaOf('a1', 0),
      { id: 1, event: 'tool_call', data: { id: 'call_1', name: 'run_code', args: {}, status: 'pending' } },
      { id: 2, event: 'tool_call', data: { id: 'call_1', name: 'run_code', args: { code: '6*7' }, status: 'awaiting_approval' } },
    )
    const allow = await screen.findByRole('button', { name: 'Allow' })
    await act(async () => { fireEvent.click(allow) })
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/conversations/c1/tool-calls/call_1/approve')).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/approve'))!.body).toEqual({ toolName: 'run_code', decision: 'allow' })
  })

  it('a send refused because a reply already runs (409) reads the chat again and attaches to that reply', async () => {
    details.set('c1', conversation('c1', [message('u0', 1, 'user', 'earlier')], null))
    const s = liveStream()
    streams = [s]
    posts = [json({ error: { code: 'generation_in_flight', message: 'A generation is already running for this conversation.' } }, 409)]
    await renderScreen('/chat/c1')
    const ta = await screen.findByPlaceholderText(/^Message /)
    // Another device's reply started meanwhile: the daemon now names it.
    details.set('c1', conversation('c1', [message('u0', 1, 'user', 'earlier'), message('u9', 2, 'user', 'from the phone'), message('a9', 3, 'assistant', '', { aborted: false })], 'a9'))
    fireEvent.change(ta, { target: { value: 'me too' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    await waitFor(() => expect(streamGets()).toHaveLength(1))
    await s.push(metaOf('a9'), metaOf('a9', 0), delta(1, 'The phone\'s answer'))
    expect(await screen.findByText(/The phone's answer/)).toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()
    expect(postsSent()).toHaveLength(1)
  })

  it('a newer reply named between two reads (one stopped elsewhere, another device\'s started) is the one followed', async () => {
    runningChat('a1')
    const s1 = liveStream()
    const s2 = liveStream()
    streams = [s1, s2]
    const view = await renderScreen('/chat/c1')
    await s1.push(metaOf('a1'), metaOf('a1', 0), delta(1, 'First reply'))
    expect(await screen.findByText(/First reply/)).toBeInTheDocument()
    // Reply 1 was stopped from another tab and is still unwinding (its stream has not ended); reply 2 now holds the chat.
    details.set('c1', conversation('c1', [message('u1', 1, 'user', 'tell me a story'), message('a1', 2, 'assistant', 'First reply', { aborted: true }), message('u2', 3, 'user', 'again'), message('a2', 4, 'assistant', '', { aborted: false })], 'a2'))
    await view.poll()
    await waitFor(() => expect(streamGets()).toHaveLength(2))
    expect(s1.aborted()).toBe(true)
    await s2.push(metaOf('a2'), metaOf('a2', 0), delta(1, 'Second reply'))
    expect(await screen.findByText(/Second reply/)).toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()
  })

  it('leaving the chat screen mid-reply does not stop it; coming back shows it live with Stop', async () => {
    details.set('c1', conversation('c1', [message('u0', 1, 'user', 'earlier')], null))
    const post = liveStream()
    const back = liveStream()
    posts = [post]
    streams = [back]
    await renderScreen('/chat/c1')
    const ta = await screen.findByPlaceholderText(/^Message /)
    fireEvent.change(ta, { target: { value: 'write an essay' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    runningChat()
    await post.push(metaOf('a1', 0), delta(1, 'Paragraph one. '))
    expect(await screen.findByText(/Paragraph one\./)).toBeInTheDocument()

    await act(async () => { navigate('/models'); await settle() })
    expect(screen.getByText('Models screen')).toBeInTheDocument()
    expect(post.aborted()).toBe(true) // the page stopped following...
    expect(calls.some((c) => c.url === '/api/v1/chat/stop')).toBe(false) // ...and stopped nothing

    await act(async () => { navigate('/chat/c1'); await settle() })
    await waitFor(() => expect(streamGets()).toHaveLength(1))
    expect(streamGets()[0].url).toBe('/api/v1/conversations/c1/stream')
    await back.push(metaOf('a1'), metaOf('a1', 0), delta(1, 'Paragraph one. '), delta(2, 'Paragraph two.'))
    expect(await screen.findByText(/Paragraph one\. Paragraph two\./)).toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()
    expect(postsSent()).toHaveLength(1)
  })

  it('leaving the chat screen while a send waits for the daemon\'s answer does not cancel it; once taken, the page lets the reply go', async () => {
    details.set('c1', conversation('c1', [message('u0', 1, 'user', 'earlier')], null))
    const held = heldPost()
    const post = liveStream()
    const back = liveStream()
    posts = [held]
    streams = [back]
    await renderScreen('/chat/c1')
    const ta = await screen.findByPlaceholderText(/^Message /)
    fireEvent.change(ta, { target: { value: 'describe this photo' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    await waitFor(() => expect(postsSent()).toHaveLength(1))

    // A large image still going up over a slow tunnel, say: the daemon has not answered the POST.
    await act(async () => { navigate('/models'); await settle() })
    expect(screen.getByText('Models screen')).toBeInTheDocument()
    expect(held.aborted()).toBe(false) // the send goes on to the daemon...

    runningChat()
    await held.answer(post)
    expect(post.aborted()).toBe(true) // ...which has it now: the page lets go of the reply, and stops nothing
    expect(calls.some((c) => c.url === '/api/v1/chat/stop')).toBe(false)

    await act(async () => { navigate('/chat/c1'); await settle() })
    await waitFor(() => expect(streamGets()).toHaveLength(1))
    await back.push(metaOf('a1'), metaOf('a1', 0), delta(1, 'A photo of a cat.'))
    expect(await screen.findByText(/A photo of a cat\./)).toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()
    expect(postsSent()).toHaveLength(1)
  })

  it('a page opened with no chat named opens the last one shown when a reply of it still runs', async () => {
    runningChat()
    localStorage.setItem('tllm-last-chat-conv', 'c1')
    const s = liveStream()
    streams = [s]
    await renderScreen('/chat')
    await waitFor(() => expect(streamGets()).toHaveLength(1))
    await s.push(metaOf('a1'), metaOf('a1', 0), delta(1, 'Still going'))
    expect(await screen.findByText(/Still going/)).toBeInTheDocument()
    expect(screen.getByText('tell me a story')).toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()
  })

  it('a page opened with no chat named stays on a new chat when the last one has nothing running', async () => {
    details.set('c1', conversation('c1', [message('u1', 1, 'user', 'tell me a story'), message('a1', 2, 'assistant', 'The end.', { totalMs: 5 })], null))
    localStorage.setItem('tllm-last-chat-conv', 'c1')
    await renderScreen('/chat')
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/conversations/c1')).toBe(true))
    await act(settle)
    expect(screen.queryByText('tell me a story')).toBeNull()
    expect(streamGets()).toHaveLength(0)
  })

  it('the sidebar shows a reply running in a chat this page did not start', async () => {
    details.set('c1', conversation('c1', [message('u0', 1, 'user', 'earlier')], null))
    details.set('c2', conversation('c2', [], null))
    running.c2 = true
    await renderScreen('/chat/c1')
    const row = (await screen.findByText('Chat c2')).closest('div')!.parentElement!
    expect(within(row).getByLabelText('Generating')).toBeInTheDocument()
    expect(within(screen.getByText('Chat c1').closest('div')!.parentElement!).queryByLabelText('Generating')).toBeNull()
  })
})

describe('ChatScreen — the open chat in the address', () => {
  // Each test starts from a page of its own: the address it opened on, with /models before it in the history.
  beforeEach(() => {
    history.replaceState(null, '', '/models')
  })
  afterEach(() => {
    history.replaceState(null, '', '/')
  })
  const openAt = (path: string) => history.pushState(null, '', path)
  const sendFromComposer = async (text: string) => {
    const ta = await screen.findByPlaceholderText(/^Message /)
    fireEvent.change(ta, { target: { value: text } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
  }

  it('a new chat is named in the address once it has its id, with no history entry of its own; a reload opens it', async () => {
    openAt('/workspace/chat')
    const entries = history.length
    const post = liveStream()
    posts = [post]
    const view = await renderInBrowser()
    await sendFromComposer('hello there')
    await waitFor(() => expect(location.pathname).toBe('/workspace/chat/c9'))
    details.set('c9', conversation('c9', [message('u1', 1, 'user', 'hello there'), message('a1', 2, 'assistant', '', { aborted: false })], 'a1'))
    await post.push(metaOf('a1', 0), delta(1, 'Hi!'), doneWith(2, message('a1', 2, 'assistant', 'Hi!', { aborted: false, totalMs: 5 })))
    expect(history.length).toBe(entries)

    // A reload (or the desktop app's Ctrl+R): a fresh page at the same address.
    details.set('c9', conversation('c9', [message('u1', 1, 'user', 'hello there'), message('a1', 2, 'assistant', 'Hi!', { aborted: false, totalMs: 5 })], null))
    view.unmount()
    await renderInBrowser()
    expect(await screen.findByText('hello there')).toBeInTheDocument()
    expect(screen.getByText('Hi!')).toBeInTheDocument()
  })

  it('picking a chat and New chat replace the address; Back then leaves the chat screen instead of walking through chats', async () => {
    details.set('c1', conversation('c1', [message('u1', 1, 'user', 'first chat')], null))
    details.set('c2', conversation('c2', [message('u2', 1, 'user', 'second chat')], null))
    openAt('/workspace/chat/c1')
    const entries = history.length
    await renderInBrowser()
    expect(await screen.findByText('first chat')).toBeInTheDocument()

    await act(async () => { fireEvent.click(await screen.findByText('Chat c2')) })
    expect(await screen.findByText('second chat')).toBeInTheDocument()
    expect(location.pathname).toBe('/workspace/chat/c2')
    await act(async () => { fireEvent.click(screen.getByTitle('New chat (Ctrl+N)')) })
    expect(location.pathname).toBe('/workspace/chat')
    expect(history.length).toBe(entries)

    await pressBack()
    expect(location.pathname).toBe('/models')
    expect(screen.getByText('Models screen')).toBeInTheDocument()
  })

  it('on a phone, Back still closes the conversation drawer, and a chat picked in it is the one the address names after', async () => {
    layout.desktop = false
    details.set('c1', conversation('c1', [message('u1', 1, 'user', 'first chat')], null))
    details.set('c2', conversation('c2', [message('u2', 1, 'user', 'second chat')], null))
    openAt('/workspace/chat/c1')
    const entries = history.length
    await renderInBrowser()
    expect(await screen.findByText('first chat')).toBeInTheDocument()

    // Back closes the open drawer and stays in the chat.
    await act(async () => { fireEvent.click(screen.getByLabelText('Open conversations')) })
    await historySettled()
    expect(history.length).toBe(entries + 1)
    await pressBack()
    expect(location.pathname).toBe('/workspace/chat/c1')
    expect(screen.getByText('first chat')).toBeInTheDocument()

    // A chat picked in the drawer closes it; the entry the history lands on names that chat.
    await act(async () => { fireEvent.click(screen.getByLabelText('Open conversations')) })
    await historySettled()
    await act(async () => { fireEvent.click(await screen.findByText('Chat c2')) })
    await historySettled()
    expect(await screen.findByText('second chat')).toBeInTheDocument()
    expect(location.pathname).toBe('/workspace/chat/c2')
    expect((history.state as { tllmOverlay?: number } | null)?.tllmOverlay).toBeUndefined()

    await pressBack()
    expect(location.pathname).toBe('/models')
  })

  it('Back to the chat screen before the daemon has answered a new chat\'s first send shows its reply once it runs', async () => {
    openAt('/workspace/chat')
    const held = heldPost()
    const post = liveStream()
    const back = liveStream()
    posts = [held]
    streams = [back]
    const view = await renderInBrowser()
    await sendFromComposer('write a poem')
    await waitFor(() => expect(postsSent()).toHaveLength(1))
    await act(async () => { navigate('/models'); await settle() })
    expect(screen.getByText('Models screen')).toBeInTheDocument()

    await pressBack()
    // The daemon takes the send only now: the reply runs.
    details.set('c9', conversation('c9', [message('u1', 1, 'user', 'write a poem'), message('a1', 2, 'assistant', '', { aborted: false })], 'a1'))
    await held.answer(post)
    expect(await screen.findByText('write a poem')).toBeInTheDocument()
    await view.poll() // the open chat's 4 s poll names the running reply
    await waitFor(() => expect(streamGets()).toHaveLength(1))
    await back.push(metaOf('a1'), metaOf('a1', 0), delta(1, 'Roses are red'))
    expect(await screen.findByText(/Roses are red/)).toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()
    expect(postsSent()).toHaveLength(1)
  })

  it('New chat pressed while the reopen read is on its way is not undone by its answer', async () => {
    runningChat()
    localStorage.setItem('tllm-last-chat-conv', 'c1')
    let release!: () => void
    holdDetail = new Promise<void>((r) => { release = r })
    openAt('/workspace/chat')
    await renderInBrowser()
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/conversations/c1')).toBe(true))
    await act(async () => { fireEvent.click(await screen.findByTitle('New chat (Ctrl+N)')) })
    await act(async () => { release(); await settle() })
    await act(settle)
    expect(screen.queryByText('tell me a story')).toBeNull()
    expect(streamGets()).toHaveLength(0)
    expect(location.pathname).toBe('/workspace/chat')
  })
})
