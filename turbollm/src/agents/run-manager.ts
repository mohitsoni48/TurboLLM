// AgentRunManager — daemon-owned agent runs (spec 13 §§5-6, Phase 2).
// Ports the reconnect machinery from the retired AgentRunner (RunBuffer ring +
// EventEmitter live-tail + subscribe() + reconcileOnStartup + interruptActive) but
// drives each run through the pi SDK (runAgentSession) instead of the old
// runGeneration+checkbox loop. One active run at a time; extras queue.
import { EventEmitter } from 'node:events'
import type { Deps } from '../deps'
import type { AgentType } from '../config/config'
import { runAgentSession } from './pi-adapter'
import { buildBridgedTools } from './pi-adapter'
import { makeToolCallGuard } from './fs-guard'
import { createReadFileTool, createListDirTool, createGlobTool, createWriteFileTool } from './fs-tools'
import { SkillStore } from './skills'
import { engineModelAlias } from '../engines/compat'

const BUFFER_CAP = 2000

export interface BufferedEvent {
  seq: number
  event: string
  data: unknown
}

class RunBuffer {
  private events: BufferedEvent[] = []
  private next = 0

  push(event: string, data: unknown): BufferedEvent {
    const ev: BufferedEvent = { seq: this.next++, event, data }
    this.events.push(ev)
    if (this.events.length > BUFFER_CAP) this.events.shift()
    return ev
  }

  since(fromSeq: number): BufferedEvent[] {
    return this.events.filter((e) => e.seq >= fromSeq)
  }
}

export interface LaunchParams {
  agentId: string
  title: string
  userMessage: string
}

interface PendingRun extends LaunchParams {
  id: string
  convId: string
}

export class AgentRunManager {
  private d: Deps
  private skills: SkillStore
  private buffers = new Map<string, RunBuffer>()
  private emitters = new Map<string, EventEmitter>()
  private acs = new Map<string, AbortController>()
  private queue: PendingRun[] = []
  private active: string | null = null
  private interruptedIds = new Set<string>()

  constructor(d: Deps) {
    this.d = d
    this.skills = new SkillStore(d.store.dir())
  }

  /** On startup: mark any DB runs left in queued/running state as interrupted. */
  reconcileOnStartup(): void {
    const runs = this.d.db.listAgentRuns?.({ statuses: ['queued', 'running'] }) ?? []
    for (const run of runs) {
      this.d.db.updateAgentRun?.(run.id, { status: 'interrupted', endedAt: new Date().toISOString() })
    }
  }

  /** Resolve an agent definition by id from config. */
  private agent(agentId: string): AgentType | undefined {
    return this.d.store.snapshot().agents.agents.find((a) => a.id === agentId)
  }

  /** Create a new agent run and queue it. Returns the run ID immediately. */
  async launch(params: LaunchParams): Promise<string> {
    const db = this.d.db
    const agent = this.agent(params.agentId)
    if (!agent) throw new Error(`Unknown agent: ${params.agentId}`)

    const conv = db.createConversation({
      title: params.title,
      systemPrompt: '',
      kind: 'agent',
    })

    const run = db.createAgentRun?.({
      convId: conv.id,
      title: params.title,
      allowedTools: [],
      agentId: params.agentId,
    })
    if (!run) throw new Error('createAgentRun not available (DB migration pending?)')

    this.queue.push({ ...params, id: run.id, convId: conv.id })
    void this.processNext()
    return run.id
  }

  /** Resolve the tools + system prompt an agent's skills grant. */
  private resolveSkills(agent: AgentType): { toolNames: string[]; systemPrompt: string } {
    const all = this.skills.list()
    const active = agent.skills.includes('*') ? all : all.filter((s) => agent.skills.includes(s.id))
    const toolNames = [...new Set(active.flatMap((s) => s.tools))]
    const instructions = active.map((s) => s.instructions).filter(Boolean).join('\n\n')
    const systemPrompt = [
      `You are ${agent.name}. ${agent.description}`,
      instructions,
    ].filter(Boolean).join('\n\n')
    return { toolNames, systemPrompt }
  }

  private async processNext(): Promise<void> {
    if (this.active !== null || this.queue.length === 0) return
    const pending = this.queue.shift()!
    this.active = pending.id

    const buffer = new RunBuffer()
    const emitter = new EventEmitter()
    emitter.setMaxListeners(50)
    const ac = new AbortController()

    this.buffers.set(pending.id, buffer)
    this.emitters.set(pending.id, emitter)
    this.acs.set(pending.id, ac)

    const sink = ({ event, data }: { event: string; data: unknown }) => {
      const ev = buffer.push(event, data)
      emitter.emit('event', ev)
    }

    this.d.db.updateAgentRun?.(pending.id, { status: 'running', startedAt: new Date().toISOString() })

    const ms = this.d.manager.status()
    const target = this.d.manager.target()
    const agent = this.agent(pending.agentId)

    if (!agent) {
      this.d.db.updateAgentRun?.(pending.id, { status: 'failed', error: 'Agent not found', endedAt: new Date().toISOString() })
      sink({ event: 'error', data: { code: 'agent_not_found', message: 'Agent definition no longer exists.' } })
      this.finish(pending.id)
      return
    }
    if (ms.state !== 'running' || !ms.model || !target) {
      this.d.db.updateAgentRun?.(pending.id, { status: 'failed', error: 'Model not loaded', endedAt: new Date().toISOString() })
      sink({ event: 'error', data: { code: 'model_not_loaded', message: 'Load a model first.' } })
      this.finish(pending.id)
      return
    }

    // Persist the turn to the run's conversation (reuses the messages table).
    this.d.db.addMessage(pending.convId, 'user', pending.userMessage)
    this.d.db.addMessage(pending.convId, 'assistant', '', { stats: { aborted: false } })
    const assistantMsg = this.d.db.getLastMessage(pending.convId)!

    // Accumulate the streamed assistant text so it lands in the DB on completion.
    let fullContent = ''

    try {
      const { toolNames, systemPrompt } = this.resolveSkills(agent)
      const dataDir = this.d.store.dir()

      // FS tools (always available to the adapter; the guard + skill grants gate them).
      const fsTools = [createReadFileTool(), createListDirTool(), createGlobTool(), createWriteFileTool()]
      // Bridged ToolRegistry tools (web_search/fetch_url/run_code/mcp__*) the agent's skills grant.
      const bridged = await buildBridgedTools(this.d, agent)
      const bridgedNames = new Set(bridged.map((t) => t.name))

      const guard = makeToolCallGuard(agent, dataDir, bridgedNames)
      const modelId = engineModelAlias(this.d.registry.active()?.kind ?? '') ?? ms.model.key

      // Anchor pi's own framing to the agent's primary writable root (its workspace),
      // so the default system prompt treats that folder as in-scope.
      const cwd = agent.writeRoots[0] === '<dataDir>' || !agent.writeRoots[0] ? dataDir : agent.writeRoots[0]

      await runAgentSession(
        {
          baseUrl: `${target}/v1`,
          modelId,
          agent,
          systemPrompt,
          userMessage: pending.userMessage,
          tools: toolNames,
          customTools: [...fsTools, ...bridged],
          onToolCall: guard,
          gate: this.d.gate,
          cwd,
          onEvent: (ev) => {
            if (ev.event === 'delta') {
              const d = ev.data as { delta?: string }
              if (typeof d.delta === 'string') fullContent += d.delta
            }
            sink(ev)
          },
        },
        ac.signal,
      )
      this.d.db.updateMessage(assistantMsg.id, { content: fullContent, stats: { aborted: false } })
      this.d.db.updateAgentRun?.(pending.id, { status: 'done', endedAt: new Date().toISOString() })
    } catch (e) {
      const isAbort = (e as Error)?.name === 'AbortError'
      this.d.db.updateMessage(assistantMsg.id, { content: fullContent, stats: { aborted: isAbort } })
      // interruptActive() pre-writes 'interrupted' status — don't overwrite it.
      if (!this.interruptedIds.delete(pending.id)) {
        this.d.db.updateAgentRun?.(pending.id, {
          status: isAbort ? 'cancelled' : 'failed',
          error: isAbort ? undefined : (e as Error).message,
          endedAt: new Date().toISOString(),
        })
      }
    } finally {
      this.finish(pending.id)
    }
  }

  private finish(id: string): void {
    this.emitters.get(id)?.emit('done')
    this.acs.delete(id)
    this.active = null
    // Delay cleanup so in-flight subscribers can drain pending events.
    setTimeout(() => { this.buffers.delete(id); this.emitters.delete(id) }, 5000)
    void this.processNext()
  }

  cancel(id: string): boolean {
    const ac = this.acs.get(id)
    if (ac) {
      ac.abort()
      this.d.db.updateAgentRun?.(id, { status: 'cancelled', endedAt: new Date().toISOString() })
      return true
    }
    const qIdx = this.queue.findIndex((r) => r.id === id)
    if (qIdx >= 0) {
      this.queue.splice(qIdx, 1)
      this.d.db.updateAgentRun?.(id, { status: 'cancelled', endedAt: new Date().toISOString() })
      return true
    }
    return false
  }

  /** Called by the engine manager when the active model is evicted. */
  interruptActive(): void {
    if (!this.active) return
    this.interruptedIds.add(this.active)
    this.acs.get(this.active)?.abort()
    this.d.db.updateAgentRun?.(this.active, { status: 'interrupted', endedAt: new Date().toISOString() })
  }

  subscribe(runId: string, fromSeq: number): AsyncIterable<BufferedEvent> & { close: () => void } {
    const buffer = this.buffers.get(runId)
    const emitter = this.emitters.get(runId)

    if (!emitter) {
      return {
        close() {},
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ value: undefined as unknown as BufferedEvent, done: true as const }),
            return: async () => ({ value: undefined as unknown as BufferedEvent, done: true as const }),
          }
        },
      }
    }

    let closed = false
    const pending: BufferedEvent[] = buffer ? buffer.since(fromSeq) : []
    let resolver: ((v: IteratorResult<BufferedEvent>) => void) | null = null

    const onEvent = (ev: BufferedEvent) => {
      if (closed) return
      if (resolver) { const r = resolver; resolver = null; r({ value: ev, done: false }) }
      else pending.push(ev)
    }
    const onDone = () => {
      if (resolver) { const r = resolver; resolver = null; r({ value: undefined as unknown as BufferedEvent, done: true }) }
    }

    emitter.on('event', onEvent)
    emitter.once('done', onDone)

    function close() {
      if (closed) return
      closed = true
      emitter!.off('event', onEvent)
      emitter!.off('done', onDone)
      if (resolver) { const r = resolver; resolver = null; r({ value: undefined as unknown as BufferedEvent, done: true }) }
    }

    return {
      close,
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<BufferedEvent>> {
            if (closed) return Promise.resolve({ value: undefined as unknown as BufferedEvent, done: true })
            if (pending.length > 0) return Promise.resolve({ value: pending.shift()!, done: false })
            return new Promise<IteratorResult<BufferedEvent>>((res) => { resolver = res })
          },
          return(): Promise<IteratorResult<BufferedEvent>> {
            close()
            return Promise.resolve({ value: undefined as unknown as BufferedEvent, done: true })
          },
        }
      },
    }
  }
}
