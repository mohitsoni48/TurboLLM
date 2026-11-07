import { Agent } from 'undici'

// The dispatcher behind the daemon's global fetch. Engine traffic rides it, and an engine request is long-lived:
//  - an SSE generation holds its socket for the whole generation, so a per-origin socket cap (undici's `connections`)
//    is a hidden concurrency limit that queues request N+1 inside undici AFTER the GenerationGate admitted it. An
//    engine with --parallel 16, or vLLM, must be able to hold that many streams; undici's default is unlimited.
//  - llama-server answers a non-streaming request only after the whole generation, and an OpenAI-protocol prefill is
//    silent just as long, so undici's 300 s headersTimeout/bodyTimeout would fail it as engine_unreachable although the
//    gate allows 600 s. Both are off: a cancelled request ends through its AbortSignal (the client-abort chain), and
//    downloads, which want stall detection, run their own timers in downloads/http-get.ts.
const options: Agent.Options = { keepAliveMaxTimeout: 60_000, headersTimeout: 0, bodyTimeout: 0 }

export const createDaemonDispatcher = Object.assign(() => new Agent(options), { options })
