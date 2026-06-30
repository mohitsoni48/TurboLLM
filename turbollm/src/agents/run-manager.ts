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
import { createUpdateDocTool, createCompleteTaskTool, type CompletionSignal } from './task-tools'
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

    // Accumulate the streamed assistant text so it lands in the DB on completion.
    let fullContent = ''
    // Hard-ceiling state (hoisted so the catch block can distinguish "hit the limit"
    // from a user cancel / real failure). Clamp defensively even though config validates.
    const maxToolCalls = Math.max(1, Math.min(200, Math.floor(agent.maxIterations ?? 30)))
    let hitCeiling = false
    // assistantMsg is assigned inside the try (the conversation could be deleted between
    // launch and run); the catch/finally must tolerate it being undefined.
    let assistantMsg: ReturnType<Deps['db']['getLastMessage']> | undefined

    try {
      // Record the model that runs this contract + persist the turn. These DB writes are
      // INSIDE the try: if the conversation was deleted between launch and now, the FK
      // throw lands in catch (not as an unhandled rejection that wedges the queue, H3).
      this.d.db.updateConversation(pending.convId, { modelKey: ms.model.key })
      this.d.db.addMessage(pending.convId, 'user', pending.userMessage)
      this.d.db.addMessage(pending.convId, 'assistant', '', { stats: { aborted: false } })
      assistantMsg = this.d.db.getLastMessage(pending.convId)
      if (!assistantMsg) throw new Error('conversation_gone')

      const { toolNames, systemPrompt } = this.resolveSkills(agent)
      const dataDir = this.d.store.dir()

      // FS tools (always present to the adapter; the guard + skill grants gate them).
      const fsTools = [createReadFileTool(), createListDirTool(), createGlobTool(), createWriteFileTool()]
      // Bridged ToolRegistry tools the agent's skills grant (by tool NAME). run_code is
      // never bridged into an autonomous run (security review C4).
      const bridged = await buildBridgedTools(this.d, toolNames)
      const bridgedNames = new Set(bridged.map((t) => t.name))

      const baseGuard = makeToolCallGuard(agent, dataDir, bridgedNames)
      const modelId = engineModelAlias(this.d.registry.active()?.kind ?? '') ?? ms.model.key

      // Hard ceiling (spec 13 §12.2/§10): pi has no built-in step cap and a small model
      // may loop forever without calling complete_task. The guard fires before every tool
      // execution, so count there: once the cap is hit, abort the run and block further
      // tools. Reaching the ceiling is NOT success — the run ends and awaits review.
      let toolCallCount = 0
      const guard: typeof baseGuard = (toolName, input) => {
        toolCallCount++
        if (toolCallCount > maxToolCalls) {
          hitCeiling = true
          ac.abort()
          return { block: true, reason: `iteration limit (${maxToolCalls}) reached — stopping for review` }
        }
        return baseGuard(toolName, input)
      }

      // Task-tracking tools (§12.2): the working doc + the model's done-signal. Always
      // available — granted to any agent whose skills include the `task-tracking` skill
      // (the default agent does). The guard allows update_doc/complete_task by name.
      const completion: CompletionSignal = { done: false, summary: '' }
      const taskTools = [createUpdateDocTool(this.d.db, pending.id), createCompleteTaskTool(completion)]

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
          customTools: [...fsTools, ...taskTools, ...bridged],
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
      if (assistantMsg) this.d.db.updateMessage(assistantMsg.id, { content: fullContent, stats: { aborted: false } })
      // The run reaches 'done' whether the model called complete_task or just stopped.
      // Disposition (complete/miss → track record) happens via the user's button (§14).
      this.d.db.updateAgentRun?.(pending.id, { status: 'done', endedAt: new Date().toISOString() })
      // Synthetic terminal event in the buffer (M1) so a client replaying from fromSeq
      // ALWAYS gets a 'done' frame and never spins.
      sink({ event: 'done', data: { runId: pending.id, status: 'done' } })
    } catch (e) {
      const isAbort = (e as Error)?.name === 'AbortError'
      if (assistantMsg) this.d.db.updateMessage(assistantMsg.id, { content: fullContent, stats: { aborted: isAbort } })
      // interruptActive() pre-writes 'interrupted' status — don't overwrite it.
      if (!this.interruptedIds.delete(pending.id)) {
        if (hitCeiling) {
          // Hit the iteration ceiling — NOT a failure or cancel. Surfaces as 'done'
          // (awaiting review); the user dispositions it like any finished contract (§14).
          this.d.db.updateAgentRun?.(pending.id, { status: 'done', error: `Stopped at iteration limit (${maxToolCalls}).`, endedAt: new Date().toISOString() })
          sink({ event: 'done', data: { runId: pending.id, status: 'done', note: `Stopped after ${maxToolCalls} tool calls — needs review.` } })
        } else {
          const status = isAbort ? 'cancelled' : 'failed'
          this.d.db.updateAgentRun?.(pending.id, {
            status,
            error: isAbort ? undefined : (e as Error).message,
            endedAt: new Date().toISOString(),
          })
          // Always emit a terminal frame so the SSE stream + frontend never hang.
          sink({ event: 'error', data: { code: status, message: isAbort ? 'Cancelled.' : (e as Error).message } })
        }
      } else {
        // Interrupted by eviction — still emit a terminal frame.
        sink({ event: 'error', data: { code: 'interrupted', message: 'The model was unloaded — run interrupted.' } })
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
