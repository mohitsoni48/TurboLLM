// A local WebSocket server that plays llama-server's /v1/realtime for the tests of the spoken-reply adapter, the chat
// route and the gateway, replaying the events a real engine sent (src/engines/fixtures/llamacpp-realtime). No network
// beyond the loopback socket the test opens itself.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

type Json = Record<string, any>

/** The server events of a captured fixture, one per line of the file. */
export function loadRealtimeFixture(name: 'realtime-text-audio' | 'realtime-audio-only' | 'realtime-text-only' | 'realtime-cancelled' | 'realtime-error-unknown-voice'): Json[] {
  const path = fileURLToPath(new URL(`../engines/fixtures/llamacpp-realtime/${name}.jsonl`, import.meta.url))
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export interface FakeRealtimeOptions {
  /** The captured events to replay: its session.created and session.updated open the session, the rest is the reply. */
  fixture?: Parameters<typeof loadRealtimeFixture>[0]
  /** `complete` plays the whole reply; `cancellable` stops after the first audio delta and finishes only when
   *  `response.cancel` arrives (with a cancelled `response.done`); `silent` says nothing after `response.create`
   *  and ignores `response.cancel` too, like an engine that is not answering. */
  mode?: 'complete' | 'cancellable' | 'silent' | 'prefill'
  /** `prefill` mode: how long after `response.create` the reply gets under way. A `response.cancel` that arrives before
   *  it is dropped without a word, as llama-server drops one during prefill; one after it is acknowledged. */
  prefillMs?: number
  /** A voice name the engine refuses, answering the way a real one did (the captured error event). */
  rejectVoice?: string
}

export interface FakeRealtimeEngine {
  port: number
  baseUrl: string
  /** Every JSON message a client sent, in order, across connections. */
  received: Json[]
  /** The types of the events the server managed to send, in order: one that went out after the client closed is not here. */
  sent: string[]
  /** How many sockets were opened and how many have closed since. */
  opened: () => number
  closed: () => number
  stop: () => Promise<void>
}

export async function startFakeRealtimeEngine(opts: FakeRealtimeOptions = {}): Promise<FakeRealtimeEngine> {
  const { WebSocketServer } = require('ws') as { WebSocketServer: new (o: { port: number; host: string }) => any }
  const events = loadRealtimeFixture(opts.fixture ?? 'realtime-text-audio')
  const mode = opts.mode ?? 'complete'
  const received: Json[] = []
  const sent: string[] = []
  let opened = 0
  let closed = 0
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => wss.on('listening', resolve))

  wss.on('connection', (ws: any) => {
    opened++
    ws.on('close', () => { closed++ })
    ws.on('error', () => {})
    const send = (e: Json) => { if (ws.readyState === 1) { sent.push(e.type); ws.send(JSON.stringify(e)) } }
    let replying = false
    send(events[0])
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(String(raw)) as Json
      received.push(msg)
      if (msg.type === 'session.update') {
        const voice = msg.session?.audio?.output?.voice
        if (opts.rejectVoice && voice === opts.rejectVoice) return send(loadRealtimeFixture('realtime-error-unknown-voice')[0])
        return send(events[1])
      }
      if (msg.type === 'response.create') {
        if (mode === 'silent') return
        if (mode === 'prefill') {
          const reply = events.slice(2)
          const firstAudio = reply.findIndex((e) => e.type === 'response.output_audio.delta')
          setTimeout(() => {
            replying = true
            reply.slice(0, firstAudio + 1).forEach(send)
          }, opts.prefillMs ?? 300)
          return
        }
        const reply = events.slice(2)
        if (mode === 'complete') return reply.forEach(send)
        const firstAudio = reply.findIndex((e) => e.type === 'response.output_audio.delta')
        reply.slice(0, firstAudio + 1).forEach(send)
        return
      }
      if (msg.type === 'response.cancel' && (mode === 'cancellable' || (mode === 'prefill' && replying))) {
        send(loadRealtimeFixture('realtime-cancelled').at(-1)!)
      }
    })
  })

  return {
    port: (wss.address() as AddressInfo).port,
    baseUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    received,
    sent,
    opened: () => opened,
    closed: () => closed,
    stop: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate()
      wss.close(() => resolve())
    }),
  }
}
