import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVENT_NAMES, MAX_IDENT_LEN, structuralSanityCheck, validateEvent } from './schema'

/** A minimal well-formed journey event — the shape ADR-299 Decision 6 defines. */
function validEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    event: 'app_first_run',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.8.4', os: 'win32/x64' },
    ...over,
  }
}

test('validateEvent: rejects an event name that is not on the allow-list', () => {
  const r = validateEvent(validEvent({ event: 'prompt_captured' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /event/)
})

test('validateEvent: rejects an unknown top-level field, so a prompt cannot ride along', () => {
  const r = validateEvent(validEvent({ prompt: 'what is my ssh key' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /prompt/)
})

test('validateEvent: rejects an unknown field nested inside payload', () => {
  const r = validateEvent(
    validEvent({ event: 'feature_first_use', payload: { feature: 'chat', filePath: 'D:/secrets/id_rsa' } }),
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /filePath/)
})

test('validateEvent: accepts a well-formed feature_first_use', () => {
  const r = validateEvent(validEvent({ event: 'feature_first_use', payload: { feature: 'chat' } }))
  assert.equal(r.ok, true)
})

test('validateEvent: rejects a feature value that is not a known feature', () => {
  const r = validateEvent(validEvent({ event: 'feature_first_use', payload: { feature: 'my-secret-repo-name' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /feature/)
})

test('validateEvent: app_first_run carries no payload at all', () => {
  assert.equal(validateEvent(validEvent({ event: 'app_first_run' })).ok, true)
  const r = validateEvent(validEvent({ event: 'app_first_run', payload: { feature: 'chat' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /no payload/)
})

test('validateEvent: onboarding_step requires a known step and outcome', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'onboarding_step', payload: { step: 'model_download', outcome: 'ok' } })).ok,
    true,
  )
  const r = validateEvent(validEvent({ event: 'onboarding_step', payload: { step: 'model_download' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /outcome/)
})

test('validateEvent: first_chat is a valid onboarding step, and reports ok/fail/cancelled', () => {
  for (const outcome of ['ok', 'fail', 'cancelled']) {
    assert.equal(
      validateEvent(validEvent({ event: 'onboarding_step', payload: { step: 'first_chat', outcome } })).ok,
      true,
      `first_chat should accept outcome '${outcome}'`,
    )
  }
})

test('validateEvent: engine_build is no longer an onboarding step (ADR-323)', () => {
  // Removed because seedDefaultEngines only ever provisions a prebuilt binary — the
  // step measured a manual advanced-user action, so it read as near-total drop-off.
  const r = validateEvent(validEvent({ event: 'onboarding_step', payload: { step: 'engine_build', outcome: 'ok' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /step/)
})

test('validateEvent: model_first_load takes an optional enum failReason', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'model_first_load', payload: { outcome: 'fail', failReason: 'oom' } })).ok,
    true,
  )
  assert.equal(validateEvent(validEvent({ event: 'model_first_load', payload: { outcome: 'ok' } })).ok, true)
})

test('validateEvent: onboarding_step takes an optional enum failReason (engine_install, telemetry-review follow-up)', () => {
  assert.equal(
    validateEvent(
      validEvent({ event: 'onboarding_step', payload: { step: 'engine_install', outcome: 'fail', failReason: 'network' } }),
    ).ok,
    true,
  )
  assert.equal(
    validateEvent(validEvent({ event: 'onboarding_step', payload: { step: 'engine_install', outcome: 'ok' } })).ok,
    true,
    'failReason is optional — an ok outcome need not carry one',
  )
  const r = validateEvent(
    validEvent({ event: 'onboarding_step', payload: { step: 'engine_install', outcome: 'fail', failReason: 'oom' } }),
  )
  assert.equal(r.ok, false, "'oom' is a model-load reason, not a provisioning one — must not validate here")
})

test('validateEvent: error requires a known fingerprint', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'error', payload: { fingerprint: 'engine_crash' } })).ok,
    true,
  )
  const r = validateEvent(validEvent({ event: 'error', payload: { fingerprint: 'stack trace: at foo.ts:42' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /fingerprint/)
})

test('validateEvent: feature_used_daily requires a known feature and a bucketed count, never a raw number', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'feature_used_daily', payload: { feature: 'chat', countBucket: '6-20' } })).ok,
    true,
  )
  const r = validateEvent(validEvent({ event: 'feature_used_daily', payload: { feature: 'chat', countBucket: 17 } }))
  assert.equal(r.ok, false, 'a raw number must never validate as a countBucket')
})

test('validateEvent: model_first_load rejects a free-text failure message', () => {
  const r = validateEvent(
    validEvent({
      event: 'model_first_load',
      payload: { outcome: 'fail', failReason: 'CUDA error loading D:/models/private.gguf' },
    }),
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /failReason/)
})

test('validateEvent: feature_used_daily reports a bucket, never a raw count', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'feature_used_daily', payload: { feature: 'code', countBucket: '6-20' } })).ok,
    true,
  )
  const r = validateEvent(validEvent({ event: 'feature_used_daily', payload: { feature: 'code', countBucket: 17 } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /countBucket/)
})

/** The real shape `bench.ts` already queues today (bench.ts:1144). */
function benchEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    event: 'bench_result',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.8.4', os: 'win32/x64' },
    hw: {
      cpu: 'AMD Ryzen 9 7950X 16-Core Processor',
      ramMb: 65536,
      gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16384 }],
    },
    payload: {
      source: 'autotune',
      model: { name: 'Qwen3.6-35B-A22B', quant: 'Q4_K_M', sizeBytes: 21_000_000_000, arch: 'qwen3moe', moe: true },
      engine: { version: 'b1234' },
      params: { ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvTypeK: 'q8_0', flashAttn: 'auto' },
      result: { tps: 48.2, ttftMs: 310, vramMb: 15800, outcome: 'ok' },
    },
    ...over,
  }
}

test('validateEvent: bench_result requires a real source — autotune|chat|gateway|code', () => {
  const r = validateEvent(benchEvent({ payload: { ...(benchEvent().payload as object), source: undefined } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /source/)
})

test('validateEvent: bench_result accepts every real source value, from every real trigger', () => {
  for (const source of ['autotune', 'chat', 'gateway', 'code']) {
    const e = benchEvent()
    ;(e.payload as Record<string, unknown>).source = source
    const r = validateEvent(e)
    assert.equal(r.ok, true, r.ok === false ? `${source}: ${r.reason}` : '')
  }
})

test('validateEvent: bench_result rejects a source outside the closed enum', () => {
  const e = benchEvent()
  ;(e.payload as Record<string, unknown>).source = 'made_up_source'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /source/)
})

test('validateEvent: accepts the bench_result shape bench.ts already produces', () => {
  const r = validateEvent(benchEvent())
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('validateEvent: a model name long enough to hide a prompt is rejected', () => {
  const e = benchEvent()
  const payload = e.payload as { model: Record<string, unknown> }
  payload.model.name = 'x'.repeat(200)
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /model\.name/)
})

test('validateEvent: a model name containing a filesystem path is rejected', () => {
  const e = benchEvent()
  const payload = e.payload as { model: Record<string, unknown> }
  payload.model.name = 'D:\\models\\private\\secret.gguf'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /model\.name/)
})

test('validateEvent: a unix path smuggled through the cpu identifier is rejected', () => {
  const e = benchEvent()
  const hw = e.hw as Record<string, unknown>
  hw.cpu = '/home/mo/.ssh/id_rsa'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /hw\.cpu/)
})

test('validateEvent: an unknown field inside the bench payload is rejected', () => {
  const e = benchEvent()
  const payload = e.payload as Record<string, unknown>
  payload.systemPrompt = 'you are a helpful assistant'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /systemPrompt/)
})

test('validateEvent: an unmeasured vramMb (null) is accepted — BenchResult.vramMb is number|null', () => {
  const e = benchEvent()
  const payload = e.payload as { result: Record<string, unknown> }
  payload.result.vramMb = null
  const r = validateEvent(e)
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('validateEvent: a non-numeric t/s is rejected', () => {
  const e = benchEvent()
  const payload = e.payload as { result: Record<string, unknown> }
  payload.result.tps = 'fast'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /tps/)
})

test('validateEvent: app.version is a capped identifier, not a free string', () => {
  const r = validateEvent(validEvent({ app: { version: 'x'.repeat(200), os: 'win32/x64' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /app\.version/)
})

test('validateEvent: a prototype-chain property cannot smuggle a free-form string through payload', () => {
  // Found in Opus pre-release review: checkFields used `key in spec`, which
  // walks Object.prototype — so 'toString'/'constructor'/'valueOf' passed the
  // "known field" check and were then never validated, since the second loop
  // only iterates the spec's OWN entries. Reproducing the exact review PoC.
  const r = validateEvent(
    validEvent({
      event: 'feature_first_use',
      payload: { feature: 'chat', toString: 'C:\\Users\\Owner\\secret\\prompt.txt ' + 'x'.repeat(400) },
    }),
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /toString/)
})

test('validateEvent: a prototype-chain property cannot smuggle a free-form string through app', () => {
  const r = validateEvent(validEvent({ app: { version: '1.9.2', os: 'win32/x64', constructor: 'arbitrary' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /constructor/)
})

test('validateEvent: a prototype-chain property cannot smuggle a free-form string through the bench payload', () => {
  const e = benchEvent()
  const p = e.payload as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately
  // bypassing the compiler's own strict typing of the inherited method, since
  // the whole point is proving an untyped attacker payload can do this.
  ;(p as any).hasOwnProperty = 'smuggled'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /hasOwnProperty/)
})

test('validateEvent: app.os accepts the REAL shape sysinfo.ts produces, not a fabricated fixture', () => {
  // Found live: getSysInfo().os is `${process.platform}/${process.arch}` (sysinfo.ts),
  // e.g. "win32/x64" or "darwin/arm64" — every unit test fixture in this file (including
  // ones above) had hand-written 'win32' with no slash, so this was never exercised
  // against the real value. Every real Emitter.emit() call embeds this string
  // unconditionally, so before this test the real client could never successfully
  // queue a single journey event on any platform — confirmed by running the actual
  // daemon end-to-end and finding every event silently rejected at this exact field.
  for (const os of ['win32/x64', 'darwin/arm64', 'linux/x64']) {
    const r = validateEvent(validEvent({ app: { version: '1.9.0', os } }))
    assert.equal(r.ok, true, r.ok === false ? `${os}: ${r.reason}` : '')
  }
})

test('validateEvent: app.os still rejects a real path, despite now allowing a slash', () => {
  // The platform/arch shape is exactly ONE slash between two short alnum tokens —
  // narrow enough that a real filesystem path (multiple segments, dots, drive
  // letters, backslashes) cannot pass through the same allowance.
  for (const os of ['D:\\models\\private\\secret.gguf', '/home/mo/.ssh/id_rsa', 'win32/x64/extra', '../../etc/passwd']) {
    const r = validateEvent(validEvent({ app: { version: '1.9.0', os } }))
    assert.equal(r.ok, false, `expected ${os} to be rejected`)
  }
})

test('validateEvent: schema must exactly equal the current wire version', () => {
  // Found in Opus pre-release review: 'schema' was in ENVELOPE_KEYS (so it rode
  // through the top-level allow-list) but never actually checked — any value,
  // any size, reached the Worker and D1/PostHog verbatim.
  assert.equal(validateEvent(validEvent({ schema: 2 })).ok, false)
  assert.equal(validateEvent(validEvent({ schema: 'z'.repeat(600) })).ok, false)
  assert.equal(validateEvent(validEvent({ schema: 1 })).ok, true)
})

test('validateEvent: ts must be a bounded ISO-8601 timestamp, not an arbitrary object or string', () => {
  // Same finding: 'ts' was allow-listed but never validated at all. Reproducing
  // the review's exact PoC — a free-form path leaked through a nested field.
  const withObjectTs = validEvent()
  withObjectTs.ts = { leak: 'C:/Users/Owner/Documents/prompt.txt', big: 'y'.repeat(300) }
  assert.equal(validateEvent(withObjectTs).ok, false)

  assert.equal(validateEvent(validEvent({ ts: 'not a timestamp' })).ok, false)
  assert.equal(validateEvent(validEvent({ ts: '2026-07-29T12:00:00.000Z' })).ok, true)
})

test('validateEvent: consent_choice with an oversized schema value is still rejected', () => {
  // The finding's own example: the schema field was reachable even on
  // consent_choice, the one event required to carry nothing attributable.
  const r = validateEvent({ schema: 'q'.repeat(200), event: 'consent_choice', level: 'off' })
  assert.equal(r.ok, false)
})

test('validateEvent: a machineId that is not a plain uuid-shaped id is rejected', () => {
  const r = validateEvent(validEvent({ machineId: '../../etc/passwd' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /machineId/)
})

test('validateEvent: the Off consent ping is accepted with no machineId, app, or ts', () => {
  const r = validateEvent({ schema: 1, event: 'consent_choice', level: 'off' })
  assert.equal(r.ok, true)
})

test('validateEvent: a consent_choice may never carry a machineId, so it stays unattributable', () => {
  const r = validateEvent({
    schema: 1,
    event: 'consent_choice',
    level: 'off',
    machineId: '00000000-0000-0000-0000-000000000000',
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /machineId/)
})

test('validateEvent: consent_choice requires a known level', () => {
  const r = validateEvent({ schema: 1, event: 'consent_choice', level: 'maybe' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /level/)
})

test('validateEvent: level is rejected on any event other than consent_choice', () => {
  const r = validateEvent(validEvent({ event: 'app_first_run', level: 'anon' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /level/)
})

test('validateEvent: a normal event without a machineId is rejected', () => {
  const e = validEvent()
  delete e.machineId
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /machineId/)
})

test('validateEvent: error carries an enum fingerprint, never log text', () => {
  assert.equal(validateEvent(validEvent({ event: 'error', payload: { fingerprint: 'cuda_oom' } })).ok, true)
  const r = validateEvent(
    validEvent({ event: 'error', payload: { fingerprint: 'Traceback: /home/mo/.ssh/id_rsa not found' } }),
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /fingerprint/)
})

// structuralSanityCheck (ADR-331/333) — the coarse, permanent gate the Worker
// uses to decide "quarantine this" vs "destroy this" when validateEvent
// itself rejects an event. Every one of these cases must keep passing no
// matter how EVENT_NAMES/PAYLOAD_SPECS evolve, since that is the entire point
// of the function: it must never need to change alongside the schema.

test('structuralSanityCheck: rejects a non-object', () => {
  assert.equal(structuralSanityCheck('not an event').ok, false)
  assert.equal(structuralSanityCheck(null).ok, false)
  assert.equal(structuralSanityCheck([1, 2, 3]).ok, false)
})

test('structuralSanityCheck: accepts every current real event name, unchanged forever', () => {
  for (const event of EVENT_NAMES) {
    const r = structuralSanityCheck({ event })
    assert.equal(r.ok, true, r.ok === false ? `${event}: ${r.reason}` : '')
  }
})

test('structuralSanityCheck: accepts an event name this schema has never heard of — the whole point', () => {
  // The exact shape of the bug this exists to fix: a client on a newer schema
  // sends an event name an older deployed Worker does not recognise yet.
  const r = structuralSanityCheck({ event: 'model_load', schema: 2, payload: { quant: 'Q4_K_M' } })
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('structuralSanityCheck: rejects an event name shaped to abuse the check itself', () => {
  assert.equal(structuralSanityCheck({ event: 'x'.repeat(200) }).ok, false)
  assert.equal(structuralSanityCheck({ event: 'Not-Lowercase' }).ok, false)
  assert.equal(structuralSanityCheck({ event: '' }).ok, false)
  assert.equal(structuralSanityCheck({ event: 123 }).ok, false)
})

test('structuralSanityCheck: consent_choice may never carry anything attributable — hard invariant, not quarantine-eligible', () => {
  assert.equal(structuralSanityCheck({ event: 'consent_choice', level: 'off' }).ok, true)
  for (const banned of ['machineId', 'app', 'hw', 'ts', 'payload']) {
    const r = structuralSanityCheck({ event: 'consent_choice', level: 'off', [banned]: 'x' })
    assert.equal(r.ok, false, `consent_choice carrying ${banned} must never pass, even for quarantine`)
  }
})

test('structuralSanityCheck: a future field with a normal-length value passes, so real drift is never blocked', () => {
  const r = structuralSanityCheck({
    event: 'model_load',
    payload: { quant: 'Q4_K_M', kvTypeK: 'q8_0', aBrandNewFieldThisSchemaDoesNotKnowAbout: 'gpu_offload_partial' },
  })
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('structuralSanityCheck: rejects a string long enough to be a smuggled prompt or path, even under an unrecognized field name', () => {
  const r = structuralSanityCheck({
    event: 'app_first_run',
    prompt: 'x'.repeat(MAX_IDENT_LEN + 1),
  })
  assert.equal(r.ok, false)
})

test('structuralSanityCheck: accepts a string right at the existing bench_result identifier cap', () => {
  const r = structuralSanityCheck({ event: 'bench_result', payload: { model: { name: 'x'.repeat(MAX_IDENT_LEN) } } })
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('structuralSanityCheck: the oversized-string scan reaches nested objects and arrays alike', () => {
  const nested = structuralSanityCheck({
    event: 'bench_result',
    hw: { gpus: [{ name: 'fine' }, { name: 'x'.repeat(MAX_IDENT_LEN + 1) }] },
  })
  assert.equal(nested.ok, false)
})

test('structuralSanityCheck: a pathologically deep small payload is treated as unsafe rather than recursing unbounded', () => {
  let deep: Record<string, unknown> = { leaf: 'x' }
  for (let i = 0; i < 20; i++) deep = { nested: deep }
  const r = structuralSanityCheck({ event: 'app_first_run', payload: deep })
  assert.equal(r.ok, false)
})
