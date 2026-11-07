// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { Deps } from '../deps'
import { getSysInfo } from '../sysinfo/sysinfo'
import { readQueue, remove as removeQueued } from '../telemetry/queue'
import { readSentLog } from '../telemetry/log'
import { TELEMETRY_SCHEMA_VERSION } from '../telemetry/schema'
import { classifyProvisionFailure } from '../telemetry/classify'
import { body } from './http'

/** Telemetry: the preview, the sent log, UI actions, recovery reports and the machine id. */
export function registerTelemetryRoutes(app: Hono, d: Deps): void {
  // ── telemetry preview (spec 09 §4): a representative example of exactly what
  // each consent level would send. Illustrative only — built from getSysInfo() + a
  // sample bench record; nothing is transmitted and no real data leaves the machine.
  app.get('/api/v1/telemetry/preview', (c) => {
    const raw = (c.req.query('level') ?? '').trim()
    const level = ['off', 'anon', 'full'].includes(raw) ? raw : 'off'
    return c.json(telemetryPreview(level, d.version))
  })

  // The local submission log (ADR-299): exactly what left this machine, stored
  // verbatim. Every other privacy claim in the product is a sentence in a doc;
  // this is the one that lets a user check those sentences for themselves.
  app.get('/api/v1/telemetry/log', (c) => c.json({ entries: readSentLog(d.store.dir()) }))

  // ui_action (spec 23 §3.8): a UI click is only ever seen by the browser, so this route
  // is the only way to get it into the same consent/kill-switch/queue pipeline every other
  // event already goes through — Emitter.uiAction does the actual gating/validation/dedup;
  // this route is a thin, best-effort forwarder. Always 202 regardless of whether telemetry
  // actually accepted it (ADR-299's anti-probing opacity — same reasoning the ingest Worker
  // itself already applies to every event, not something new invented here).
  app.post('/api/v1/telemetry/ui', async (c) => {
    const b = await body<{ screen?: string; action?: string }>(c)
    try {
      if (b.screen && b.action) d.telemetry?.uiAction(b.screen, b.action)
    } catch { /* best-effort */ }
    return c.json({ ok: true }, 202)
  })

  // onboarding_recovery (spec 25 §8.2): same thin-forwarder shape and same
  // always-202 opacity as the ui route above, for the same reason — the recovery
  // buttons only exist in the browser, so this is the only way the outcome of a
  // retry can reach the queue. Wired 2026-08-21: the event had been in the
  // registry since it shipped with no caller anywhere, so the one instrument
  // meant to explain WHY setup fails had never emitted a single event.
  app.post('/api/v1/telemetry/recovery', async (c) => {
    const b = await body<{ failure?: string; failureText?: string; action?: string; outcome?: string }>(c)
    try {
      // `failureText` is the daemon's OWN local error string, round-tripped through the
      // browser only because that is where the recovery button lives. It is classified to
      // an enum member HERE and the raw text never enters an event — the same arrangement
      // `provision-state.ts` already uses, and the reason the no-free-form-strings
      // guarantee still holds for an event whose trigger is a click.
      const failure = b.failure ?? (b.failureText ? classifyProvisionFailure(b.failureText) : undefined)
      if (failure && b.action && (b.outcome === 'ok' || b.outcome === 'fail')) {
        d.telemetry?.onboardingRecovery(failure, b.action, b.outcome)
      }
    } catch { /* best-effort */ }
    return c.json({ ok: true }, 202)
  })

  // Regenerate the anonymous machine id (ADR-299). The data contract promises
  // this UUID is "not tied to identity; regeneratable" — that promise needs a
  // control behind it, not just a sentence in the docs. Anything already queued
  // is discarded: it carries the OLD id, so uploading it after a regenerate
  // would link the two ids together and defeat the point.
  app.post('/api/v1/telemetry/regenerate-id', (c) => {
    const machineId = randomUUID()
    d.store.update((cfg) => {
      cfg.telemetry.machineId = machineId
    })
    for (const q of readQueue(d.store.dir())) removeQueued(d.store.dir(), q.file)
    return c.json({ machineId })
  })
}

/** A REPRESENTATIVE illustration of exactly what each telemetry level would send
 *  (spec 09 §3–4). Built from real hardware (getSysInfo) + a sample bench record so
 *  the user can see the shape. NOTHING is transmitted; 'off' sends nothing. Forbidden
 *  fields (prompts, paths, dir names, tokens, IPs, hostnames, usernames) are excluded
 *  by construction — only whitelisted fields are placed here. */
function telemetryPreview(level: string, version: string) {
  if (level === 'off') {
    // Honest about the one exception (ADR-299 Decision 5): Off still reports the
    // choice itself, once, with nothing attached. The preview shows that exact
    // ping rather than claiming nothing is sent — this endpoint exists so the
    // user can check our claims against reality, so it must not overstate them.
    return {
      level,
      sends: true,
      note: 'Telemetry is off. The only thing ever sent is this one-time record of your choice — no machine id, no hardware, no timestamp. Nothing else, ever.',
      payload: [{ schema: TELEMETRY_SCHEMA_VERSION, event: 'consent_choice', level: 'off' }],
    }
  }
  const sys = getSysInfo()
  const hw = {
    cpu: sys.cpu,
    ramMb: sys.ramMB,
    gpus: sys.gpus.map((g) => ({ name: g.name, vramMb: g.vramMb })),
  }
  const benchEvent = {
    schema: 1,
    event: 'bench_result',
    ts: new Date().toISOString(),
    machineId: '00000000-0000-0000-0000-000000000000', // random per-install uuid (example)
    app: { version, os: sys.os },
    hw,
    payload: {
      source: 'chat',
      model: { name: 'Qwen3.6-35B', quant: 'Q4_K_M', sizeBytes: 21_000_000_000, arch: 'qwen3moe', moe: true },
      engine: { version: 'b1234' },
      params: { ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvTypeK: 'q8_0', flashAttn: 'auto' },
      result: { tps: 48.2, ttftMs: 310, vramMb: 15800, outcome: 'ok' },
    },
  }
  const events: unknown[] = [benchEvent]
  if (level === 'full') {
    // Representative, not exhaustive (this preview has always been "illustrative only" —
    // see this function's own history) — but these four are the categories spec 23 §6a's
    // privacy audit found undisclosed by the OLD wording (interaction-level UI tracking,
    // connected third-party tool identity, and the resolved load config), so they are the
    // ones that must appear here, not a token one-of-each across all 16 registered events.
    events.push({
      schema: TELEMETRY_SCHEMA_VERSION,
      event: 'error',
      ts: new Date().toISOString(),
      machineId: '00000000-0000-0000-0000-000000000000',
      app: { version, os: sys.os },
      // Error fingerprint only — a closed enum member, never the raw message or a log line.
      payload: { fingerprint: 'cuda_oom' },
    })
    events.push({
      schema: TELEMETRY_SCHEMA_VERSION,
      event: 'model_load',
      ts: new Date().toISOString(),
      machineId: '00000000-0000-0000-0000-000000000000',
      app: { version, os: sys.os },
      payload: {
        outcome: 'ok',
        trigger: 'manual',
        model: { name: 'Qwen3.6-35B', quant: 'Q4_K_M', arch: 'qwen3moe', sizeBytes: 21_000_000_000, moe: true, nativeCtx: 262144 },
        engine: { kind: 'llama-server', isCustom: false },
        params: {
          ctx: 32768, ngl: 99, nglFit: true, nCpuMoe: 0, nCpuMoeFit: false, kvTypeK: 'q8_0', kvTypeV: 'q8_0',
          kvUnified: true, kvOffload: true, flashAttn: 'auto', parallel: 1, threads: 8, threadsBatch: 8,
          cacheReuse: 256, speculative: 'off', contextOverflow: 'shift', nKeep: 0, ropeScalingType: 'none',
          useJinja: true, hasGrammar: false, hasExtraArgs: false, multiGpu: false, gpuCount: 1,
        },
        fit: { estimatedVramMb: 15800 },
      },
    })
    events.push({
      schema: TELEMETRY_SCHEMA_VERSION,
      event: 'harness_first_seen',
      ts: new Date().toISOString(),
      machineId: '00000000-0000-0000-0000-000000000000',
      app: { version, os: sys.os },
      // Which connected coding tool (e.g. Claude Code, opencode) is talking to the gateway —
      // never which files, projects, or prompts it sent.
      payload: { harness: 'claude_code', protocol: 'anthropic' },
    })
    events.push({
      schema: TELEMETRY_SCHEMA_VERSION,
      event: 'ui_action',
      ts: new Date().toISOString(),
      machineId: '00000000-0000-0000-0000-000000000000',
      app: { version, os: sys.os },
      // Which screen + button, from a fixed closed enum — never a click's surrounding
      // content, coordinates, or timing.
      payload: { screen: 'engines', action: 'install_engine' },
    })
  }
  const note =
    level === 'anon'
      ? 'Anonymized hardware + benchmark speed only. No prompts, paths, identifiers, or keys.'
      : 'Adds error fingerprints, the resolved config behind a benchmark, which connected coding tool (if any) is talking to the gateway, and which screens/buttons you use. Still no prompts, paths, files, or content.'
  return { level, sends: true, note, payload: events }
}
