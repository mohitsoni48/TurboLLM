// Core generation loop — shared by the foreground chat (chat-routes.ts) and the
// background agent runner (agents/runner.ts). The EventSink abstraction decouples
// the loop from the transport (SSE stream vs. in-memory ring buffer).
import type { Deps } from '../deps'
import { clampMaxTokens } from '../config/config'
import { engineModelAlias } from '../engines/compat'
import { feedChunk, flushState, initParseState } from './parser'
import { needsExtraPass } from './think-utils'
import { checkReply } from '../tools/research-referee.js'
import { executeToolCallWithApproval } from '../tools/execute-with-approval'
import type { ClaimVerdict, Message, MessageStats, ResearchMeta, ResearchSource, ToolCallRecord } from './db'

/** One event emitted by the generation loop — the sink decides what to do with it. */
export type EventSink = (ev: { event: string; data: unknown }) => void | Promise<void>

type ManagerStatus = ReturnType<Deps['manager']['status']>

export interface GenerationCtx {
  convId: string
  conv: NonNullable<ReturnType<Deps['db']['getConversation']>>
  engineMessages: { role: string; content: unknown }[]
  assistantMsg: Message
  ms: ManagerStatus
  target: string
  ac: AbortController
  disableThinking: boolean
  /** Hard cap on tool-loop iterations (default 10 for chat, 30 for agents). */
  maxToolIter?: number
  /** When set, only these tool names are forwarded to the engine.
   *  Used by agents to enforce the launch-time tool consent. */
  allowedTools?: string[]
  /** Skip the auto-title setTimeout after generation. */
  skipAutoTitle?: boolean
  /** Priority for the generation gate — 'fg' (foreground chat) or 'bg' (agent). */
  gatePriority?: 'fg' | 'bg'
}

/**
 * Streams an assistant turn with optional agentic tool-calling loop. Shared by the
 * messages/continue endpoints (foreground SSE) and the agent runner (background ring
 * buffer). The gate is acquired per engine call and released before tool execution
 * so the engine is free between tool iterations.
 */
export async function runGeneration(d: Deps, sink: EventSink, ctx: GenerationCtx): Promise<void> {
  const { db } = d
  const { convId, conv, assistantMsg, ms, target, ac, disableThinking } = ctx

  const convS = conv.sampling ?? {}
  const SAMPLING_KEYS: Record<string, string> = {
    temp: 'temperature', topP: 'top_p', topK: 'top_k', minP: 'min_p',
    repeatPenalty: 'repeat_penalty', presencePenalty: 'presence_penalty',
    frequencyPenalty: 'frequency_penalty',
  }
  const samplingOverride: Record<string, unknown> = {}
  for (const [camel, snake] of Object.entries(SAMPLING_KEYS)) {
    if (camel in convS) samplingOverride[snake] = convS[camel]
  }
  for (const [k, v] of Object.entries(convS)) {
    if (!(k in SAMPLING_KEYS) && k !== 'stop') samplingOverride[k] = v
  }
  const stopStrings = convS.stop as string[] | undefined
  const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0
  const MAX_TOOL_ITER = ctx.maxToolIter ?? 10
  const gatePriority = ctx.gatePriority ?? 'fg'

  const iterMessages: { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[] =
    ctx.engineMessages.map((m) => ({ role: m.role, content: m.content }))

  const CONFIDENCE_INSTRUCTION =
    '\n\nAfter reviewing the search results, include a confidence assessment on a line by itself before your final answer: `[confidence: 0.XX]` where XX is your confidence (0.0–1.0) that your answer is accurate and current. If your confidence is below 0.8, call web_search again with a more specific query first. Maximum 3 search calls per response.'
  if (conv.toolPolicy === 'force_web_search') {
    const sysIdx = iterMessages.findIndex((m) => m.role === 'system')
    if (sysIdx >= 0) {
      const existing = typeof iterMessages[sysIdx].content === 'string' ? iterMessages[sysIdx].content : ''
      iterMessages[sysIdx] = { ...iterMessages[sysIdx], content: existing + CONFIDENCE_INSTRUCTION }
    } else {
      iterMessages.unshift({ role: 'system', content: CONFIDENCE_INSTRUCTION.trim() })
    }
  }

  let toolIter = 0
  let searchCallCount = 0
  const allResearchSources: ResearchSource[] = []
  let parsedConfidence: number | undefined
  let fullContent = ''
  let fullReasoning = ''
  const allToolCalls: ToolCallRecord[] = []

  const requestStart = Date.now()
  let ttftMs = 0
  let thinkStart = 0
  let thinkEnd = 0
  let finalUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } = {}
  let finalTimings: Record<string, number> = {}
  let aborted = false
  let liveOut = 0

  d.manager.generationStart()
  // Tracks the active gate lease; always released in the finally block if still held
  // (catches AbortError mid-fetch or any other early throw).
  let currentGate: (() => void) | undefined

  try {
    let toolDefs = d.tools ? await d.tools.buildToolDefinitions() : []
    if (ctx.allowedTools) {
      toolDefs = toolDefs.filter((t) => ctx.allowedTools!.includes(t.function.name))
    }

    outerLoop: while (toolIter <= MAX_TOOL_ITER) {
      toolIter++

      // Acquire gate per engine call so fg can preempt bg between tool iterations.
      currentGate = await d.gate?.acquire(gatePriority)

      const reqBody: Record<string, unknown> = {
        model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model!.key,
        messages: iterMessages,
        stream: true,
        stream_options: { include_usage: true },
        return_progress: true,
        ...samplingOverride,
      }
      if (stopStrings?.length) reqBody.stop = stopStrings
      const cappedMax = clampMaxTokens(reqBody.max_tokens as number | undefined, maxLimit)
      if (cappedMax != null) reqBody.max_tokens = cappedMax
      else delete reqBody.max_tokens
      if (disableThinking) {
        reqBody.reasoning_budget = 0
        reqBody.chat_template_kwargs = { enable_thinking: false }
      }
      const toolsSupported = (d.registry.active()?.kind ?? '') !== 'vllm' && toolDefs.length > 0
      if (toolsSupported) reqBody.tools = toolDefs
      if (
        toolsSupported &&
        conv.toolPolicy === 'force_web_search' &&
        toolIter <= 2 &&
        toolDefs.some((t) => t.function.name === 'web_search')
      ) {
        reqBody.tool_choice = { type: 'function', function: { name: 'web_search' } }
      }

      const res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: ac.signal,
        duplex: 'half',
      })

      if (!res.ok || !res.body) {
        currentGate?.(); currentGate = undefined
        await sink({ event: 'error', data: { code: 'engine_error', message: `Engine returned ${res.status}` } })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const cancelReader = () => void reader.cancel()
      if (ac.signal.aborted) { cancelReader() }
      else { ac.signal.addEventListener('abort', cancelReader, { once: true }) }

      let roundContent = ''
      let parseState = initParseState()
      let finishReason = ''
      const pendingToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>()

      roundLoop: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break roundLoop

          let chunk: Record<string, unknown>
          try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }

          const pp = chunk.prompt_progress as { processed?: number; total?: number; tps?: number } | undefined
          if (pp && pp.total) {
            const pct = Math.round((pp.processed ?? 0) / pp.total * 100)
            d.manager.setLiveGen({ phase: 'prompt', pct, outputTokens: 0 })
            await sink({ event: 'progress', data: { phase: 'prompt', processed: pp.processed, total: pp.total, pct, tps: pp.tps ?? 0 } })
            continue
          }

          if (chunk.usage) finalUsage = chunk.usage as typeof finalUsage
          if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings

          const choices = chunk.choices as Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
            finish_reason?: string
          }> | undefined
          if (!choices?.length) continue

          if (choices[0].finish_reason) finishReason = choices[0].finish_reason
          const delta = choices[0].delta ?? {}

          if (delta.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              if (!pendingToolCalls.has(tc.index)) pendingToolCalls.set(tc.index, { id: '', name: '', argsBuffer: '' })
              const entry = pendingToolCalls.get(tc.index)!
              if (tc.id && !entry.id) entry.id = tc.id
              if (tc.function?.name && !entry.name) entry.name = tc.function.name
              if (tc.function?.arguments) entry.argsBuffer += tc.function.arguments
            }
            continue
          }

          const rc = (delta.reasoning_content ?? delta.reasoning) as string | undefined
          if (rc) {
            if (!thinkStart) thinkStart = Date.now()
            thinkEnd = Date.now()
            fullReasoning += rc
            await sink({ event: 'reasoning', data: { delta: rc } })
            continue
          }

          const raw_content = delta.content ?? ''
          if (!raw_content) continue

          const { state: nextState, events: parseEvents } = feedChunk(parseState, raw_content)
          parseState = nextState
          for (const ev of parseEvents) {
            if (ev.type === 'reasoning') {
              if (!thinkStart) thinkStart = Date.now()
              thinkEnd = Date.now()
              fullReasoning += ev.text
              await sink({ event: 'reasoning', data: { delta: ev.text } })
            } else {
              fullContent += ev.text
              roundContent += ev.text
              if (!ttftMs) ttftMs = Date.now() - requestStart
              d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: ++liveOut })
              await sink({ event: 'delta', data: { delta: ev.text } })
            }
          }
        }
      }
      ac.signal.removeEventListener('abort', cancelReader)

      for (const ev of flushState(parseState)) {
        if (ev.type === 'reasoning') {
          fullReasoning += ev.text
          await sink({ event: 'reasoning', data: { delta: ev.text } })
        } else {
          fullContent += ev.text
          roundContent += ev.text
          await sink({ event: 'delta', data: { delta: ev.text } })
        }
      }

      // Release gate BEFORE tool execution so fg can preempt between iterations.
      currentGate?.(); currentGate = undefined

      // ── Tool call execution ──────────────────────────────────────────────
      if ((finishReason === 'tool_calls' || pendingToolCalls.size > 0) && d.tools && toolIter <= MAX_TOOL_ITER) {
        const roundToolCalls = Array.from(pendingToolCalls.values())
        iterMessages.push({
          role: 'assistant',
          content: roundContent || null,
          tool_calls: roundToolCalls.map((tc) => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: tc.argsBuffer },
          })),
        })

        for (const tc of roundToolCalls) {
          let parsedArgs: Record<string, unknown>
          try { parsedArgs = JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown> }
          catch { parsedArgs = {} }

          // Background agent runs never block waiting for a human (interactive: false) —
          // 'ask'-policy tools are denied outright by the shared approval-gate executor.
          const { result, error: callError } = await executeToolCallWithApproval({
            tools: d.tools,
            sink,
            convId,
            id: tc.id,
            name: tc.name,
            args: parsedArgs,
            globalPolicies: d.store.snapshot().tools.toolPolicies ?? {},
            // Re-read fresh on every iteration rather than the `conv` snapshot captured at
            // request start, so a concurrently-updated override is always seen.
            convOverrides: d.db.getToolOverrides(convId),
            signal: ac.signal,
            interactive: false,
          })

          if (tc.name === 'web_search' && !callError) {
            searchCallCount++
            try {
              const sourceMatches = [...result.matchAll(/\[(\d+)\] (.+?)\nSource: (\S+)\nDomain: (\S+) \| Relevance: ([\d.]+) \| Freshness: (\w+)\nKey passage: ([\s\S]+?)(?=\n\[|\s*$)/g)]
              for (const m of sourceMatches) {
                allResearchSources.push({
                  title: m[2].trim(), url: m[3].trim(), domain: m[4].trim(),
                  relevanceScore: parseFloat(m[5]),
                  freshnessSignal: m[6].trim() as 'recent' | 'dated' | 'unknown',
                  passage: m[7].trim(),
                })
              }
            } catch { /* best-effort */ }
          }

          allToolCalls.push({ id: tc.id, name: tc.name, args: parsedArgs, result: callError ? undefined : result, error: callError })
          iterMessages.push({ role: 'tool', content: result, tool_call_id: tc.id })
        }

        continue outerLoop
      }

      // ── F-021: Confidence loop ───────────────────────────────────────────
      if (conv.toolPolicy === 'force_web_search' && fullContent && d.tools) {
        const confMatch = fullContent.match(/\[confidence:\s*([\d.]+)\]/i)
        if (confMatch) {
          const conf = parseFloat(confMatch[1])
          parsedConfidence = conf
          fullContent = fullContent.replace(/\[confidence:\s*[\d.]+\]\s*/gi, '').trim()
          if (conf < 0.8 && searchCallCount < 3) {
            console.log(`[chat] F-021: confidence ${conf} < 0.8 (searches: ${searchCallCount}/3) — re-entering search loop`)
            const toolDefs2 = await d.tools.buildToolDefinitions()
            if (toolDefs2.some((t) => t.function.name === 'web_search')) {
              iterMessages.push({ role: 'assistant', content: fullContent })
              iterMessages.push({
                role: 'user',
                content: `Your confidence is ${conf}. Please search again with a more specific query to improve accuracy, then provide a revised answer with an updated [confidence: X.XX] line.`,
              })
              fullContent = ''
              continue outerLoop
            }
          }
        }
      }

      break outerLoop
    }

    // ── BUG-001: Qwen3 empty-reply guard ──────────────────────────────────
    console.log(`[chat] tool loop finished after ${toolIter} iteration(s); visible content length: ${fullContent.trim().length}`)
    if (needsExtraPass(fullContent)) {
      console.log('[chat] BUG-001: final content is empty — making extra pass with tool_choice:none')
      iterMessages.push({ role: 'user', content: 'Please now write your final answer based on what you found.' })
      const reqBody: Record<string, unknown> = {
        model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model!.key,
        messages: iterMessages,
        stream: true,
        stream_options: { include_usage: true },
        return_progress: true,
        tool_choice: 'none',
        ...samplingOverride,
      }
      if (stopStrings?.length) reqBody.stop = stopStrings
      const cappedMax = clampMaxTokens(reqBody.max_tokens as number | undefined, maxLimit)
      if (cappedMax != null) reqBody.max_tokens = cappedMax
      else delete reqBody.max_tokens
      if (disableThinking) {
        reqBody.reasoning_budget = 0
        reqBody.chat_template_kwargs = { enable_thinking: false }
      }

      currentGate = await d.gate?.acquire(gatePriority)
      const res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: ac.signal,
        duplex: 'half',
      })
      if (res.ok && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        const cancelReader2 = () => void reader.cancel()
        if (ac.signal.aborted) { cancelReader2() }
        else { ac.signal.addEventListener('abort', cancelReader2, { once: true }) }

        let parseState = initParseState()
        roundLoop2: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') break roundLoop2
            let chunk: Record<string, unknown>
            try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
            if (chunk.usage) finalUsage = chunk.usage as typeof finalUsage
            if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings
            const choices = chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }> | undefined
            if (!choices?.length) continue
            const delta = choices[0].delta ?? {}
            const rc = (delta.reasoning_content ?? delta.reasoning) as string | undefined
            if (rc) { fullReasoning += rc; await sink({ event: 'reasoning', data: { delta: rc } }); continue }
            const raw_content = delta.content ?? ''
            if (!raw_content) continue
            const { state: nextState, events: parseEvents } = feedChunk(parseState, raw_content)
            parseState = nextState
            for (const ev of parseEvents) {
              if (ev.type === 'reasoning') { fullReasoning += ev.text; await sink({ event: 'reasoning', data: { delta: ev.text } }) }
              else { fullContent += ev.text; if (!ttftMs) ttftMs = Date.now() - requestStart; d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: ++liveOut }); await sink({ event: 'delta', data: { delta: ev.text } }) }
            }
          }
        }
        ac.signal.removeEventListener('abort', cancelReader2)
        for (const ev of flushState(parseState)) {
          if (ev.type === 'reasoning') { fullReasoning += ev.text; await sink({ event: 'reasoning', data: { delta: ev.text } }) }
          else { fullContent += ev.text; await sink({ event: 'delta', data: { delta: ev.text } }) }
        }
      }
      currentGate?.(); currentGate = undefined
    }
  } catch (e: unknown) {
    const isAbort = (e as Error)?.name === 'AbortError'
    aborted = isAbort
    if (!isAbort) await sink({ event: 'error', data: { code: 'engine_stopped', message: (e as Error).message } })
  } finally {
    currentGate?.()  // release if thrown mid-fetch or mid-reader
    d.manager.generationEnd()
  }

  const totalMs = Date.now() - requestStart
  const thinkMs = thinkStart && thinkEnd ? thinkEnd - thinkStart : 0
  const ctxMax = ms.model?.ctx ?? 4096

  const stats: Partial<MessageStats> = {
    ttftMs, totalMs, thinkMs,
    ctxUsed: (finalUsage.prompt_tokens ?? 0) + (finalUsage.completion_tokens ?? 0),
    ctxMax, model: ms.model?.name ?? '', aborted,
  }
  const fullPrompt = finalUsage.prompt_tokens ?? 0
  const cachedExplicit = finalUsage.prompt_tokens_details?.cached_tokens
  if (finalTimings.prompt_n) {
    const processed = finalTimings.prompt_n
    stats.promptTokens = fullPrompt || processed
    stats.promptMs     = finalTimings.prompt_ms
    stats.promptTps    = finalTimings.prompt_per_second
    stats.genTokens    = finalTimings.predicted_n
    stats.genMs        = finalTimings.predicted_ms
    stats.tps          = finalTimings.predicted_per_second
    stats.cachedTokens = cachedExplicit ?? Math.max(0, (fullPrompt || processed) - processed)
  } else {
    stats.promptTokens = fullPrompt
    stats.genTokens    = finalUsage.completion_tokens ?? 0
    stats.genMs        = totalMs - ttftMs
    stats.tps          = stats.genMs > 0 ? Math.round((stats.genTokens / stats.genMs) * 1000 * 10) / 10 : 0
    stats.cachedTokens = cachedExplicit ?? 0
  }

  let refereeVerdicts: ClaimVerdict[] | undefined
  if (conv.toolPolicy === 'force_web_search' && fullContent && allResearchSources.length > 0) {
    try { refereeVerdicts = checkReply(fullContent, allResearchSources) } catch { /* best-effort */ }
  }

  const researchMeta: ResearchMeta | undefined =
    conv.toolPolicy === 'force_web_search' && (parsedConfidence !== undefined || allResearchSources.length > 0 || refereeVerdicts !== undefined)
      ? {
          confidence: parsedConfidence,
          sources: allResearchSources.length > 0 ? allResearchSources : undefined,
          refereeVerdicts: refereeVerdicts && refereeVerdicts.length > 0 ? refereeVerdicts : undefined,
        }
      : undefined

  db.updateMessage(assistantMsg.id, { content: fullContent, reasoning: fullReasoning, toolCalls: allToolCalls, stats, researchMeta })
  db.touchConversation(convId)

  try {
    d.manager.recordCompletion({
      inputTokens: stats.promptTokens,
      outputTokens: stats.genTokens,
      promptTps: stats.promptTps,
      genTps: stats.tps,
    })
  } catch { /* swallow */ }

  const finalMsg = db.getMessage(assistantMsg.id)!
  try {
    await sink({ event: 'done', data: { message: finalMsg } })
  } catch { /* client gone */ }

  if (!aborted && !ctx.skipAutoTitle && conv.title === 'New chat' && d.store.snapshot().daemon.autoGenerateTitles) {
    setTimeout(() => { void autoTitle(d, convId, ctx.engineMessages, fullContent, target) }, 1000)
  }
}

// ── Auto title generation ──────────────────────────────────────────────────────

export async function autoTitle(
  d: Deps,
  convId: string,
  prevMessages: { role: string; content: unknown }[],
  assistantReply: string,
  target: string,
): Promise<void> {
  try {
    const ms = d.manager.status()
    if (ms.state !== 'running') return
    const titleMessages = [
      ...prevMessages.slice(-2),
      { role: 'assistant', content: assistantReply.slice(0, 500) },
      { role: 'user', content: 'Generate a concise 3-6 word title for this conversation. Reply with ONLY the title — no quotes, no punctuation, no preamble. /no_think' },
    ]
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model?.key,
        messages: titleMessages,
        stream: false,
        temperature: 0.3,
        max_tokens: 32,
        reasoning_budget: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    let raw = data.choices?.[0]?.message?.content ?? ''
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    let title = raw.replace(/^["'""]+|["'""]+$/g, '').replace(/[.!?]+$/, '').trim().slice(0, 60)
    if (!title) {
      const firstUser = prevMessages.find((m) => m.role === 'user')?.content
      if (typeof firstUser === 'string') {
        title = firstUser.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 60)
      }
    }
    if (title && d.db.getConversation(convId)?.title === 'New chat') {
      d.db.updateConversation(convId, { title })
    }
  } catch { /* silently ignore */ }
}
