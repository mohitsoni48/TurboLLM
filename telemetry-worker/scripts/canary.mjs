#!/usr/bin/env node
// Post-deploy proof for ADR-331/333's G5: after `wrangler deploy`, actually
// fire one of every real event at the LIVE endpoint and confirm each one
// lands in D1 — the exact manual check run by hand on 2026-08-05 to verify
// the ADR-331 fix, automated so every future deploy gets the same proof
// instead of trusting that "202" means what it looks like.
//
// A 202 from the endpoint proves nothing on its own — that opacity is
// deliberate (handleIngest never tells a caller what was accepted, rejected,
// or quarantined). So this script does not stop at the HTTP response; it
// queries D1 directly afterward, the same authoritative check used to
// diagnose ADR-331 in the first place.
//
// Tagged app.version='canary' and machineId=CANARY_MACHINE_ID so every
// analytics query and the events/quarantine tables themselves can filter
// these out. consent_choice is deliberately excluded: it cannot carry `app`
// at all (ADR-299 Decision 5), so it can't be tagged for exclusion, and
// firing a synthetic one would pollute the real opt-out count — a metric
// this product actually reports on. Its envelope is also the smallest and
// most stable of the nine, so it is the least likely to ever need this.

import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENDPOINT = 'https://t.turbollm.dev/v1/events'
const DB_NAME = 'turbollm-telemetry'
const CANARY_VERSION = 'canary'
const CANARY_MACHINE_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

function envelope(event, extra = {}) {
  return {
    schema: 1,
    event,
    ts: new Date().toISOString(),
    machineId: CANARY_MACHINE_ID,
    app: { version: CANARY_VERSION, os: 'win32/x64' },
    ...extra,
  }
}

const events = [
  envelope('app_first_run'),
  envelope('daily_active'),
  envelope('onboarding_step', { payload: { step: 'model_download', outcome: 'ok' } }),
  envelope('model_first_load', { payload: { outcome: 'ok' } }),
  envelope('model_load', {
    payload: {
      outcome: 'ok',
      trigger: 'manual',
      model: { name: 'canary-model', quant: 'Q4_K_M', arch: 'llama', sizeBytes: 1, moe: false, nativeCtx: 8192 },
      engine: { kind: 'llama-server', isCustom: false },
      params: {
        ctx: 8192, ngl: 1, nglFit: false, nCpuMoe: 0, nCpuMoeFit: false,
        kvTypeK: 'q8_0', kvTypeV: 'q8_0', kvUnified: true, kvOffload: true,
        flashAttn: 'auto', parallel: 1, threads: 1, threadsBatch: 1, cacheReuse: 0,
        speculative: 'off', contextOverflow: 'shift', nKeep: 0, ropeScalingType: 'none',
        useJinja: true, hasGrammar: false, hasExtraArgs: false, multiGpu: false, gpuCount: 1,
      },
      fit: { estimatedVramMb: 1 },
    },
  }),
  envelope('feature_first_use', { payload: { feature: 'chat' } }),
  envelope('feature_used_daily', { payload: { feature: 'chat', countBucket: '1' } }),
  envelope('error', { payload: { fingerprint: 'engine_crash' } }),
  envelope('bench_result', {
    hw: { cpu: 'canary-cpu', ramMb: 65536, gpus: [{ name: 'canary-gpu', vramMb: 16384 }] },
    payload: {
      source: 'autotune',
      model: { name: 'canary-model', quant: 'Q4_K_M', sizeBytes: 1, arch: 'llama', moe: false },
      engine: { version: 'canary' },
      params: { ctx: 8192, ngl: 1, nCpuMoe: 0, parallel: 1, kvTypeK: 'q8_0', flashAttn: 'auto' },
      result: { tps: 1, ttftMs: 1, vramMb: 1, outcome: 'ok' },
    },
  }),
  envelope('chat_daily', {
    payload: {
      conversations: 1, messages: 1, maxMessagesInConversation: 1, medianMessagesInConversation: 1,
      distinctModels: 1, toolCalls: 0, regenerates: 0, stops: 0,
    },
  }),
  envelope('gateway_daily', {
    payload: { harness: 'claude_code', protocol: 'anthropic', requests: 1, promptTokens: 1, genTokens: 1, distinctModels: 1 },
  }),
  envelope('harness_first_seen', { payload: { harness: 'claude_code', protocol: 'anthropic' } }),
  envelope('code_daily', { payload: { sessions: 1, turns: 1, toolCalls: 0 } }),
  envelope('ui_action', { payload: { screen: 'engines', action: 'install_engine' } }),
  envelope('ui_daily', { payload: { screen: 'engines', actions: 1, distinctActions: 1 } }),
]

// `--file` sidesteps shell-quoting but ALSO changes what wrangler returns —
// for a file it reports execution stats ("Rows read", "Database size"), not
// the query's actual row data; only `--command` returns real rows. So this
// must use `--command`, which means the SQL string has to survive the shell.
// `execFileSync` with an args array EINVALs on Windows (`npx` there is
// `npx.cmd`, a batch file, which can only be spawned through a shell) — but
// re-assembling that array into a command line for cmd.exe is exactly what
// mangled the SQL earlier (the array-to-cmd.exe escaping wrangler/Node uses
// does not wrap a multi-word `--command` value the way a real cmd.exe user
// typing it by hand would). Building the whole command line ourselves and
// running it as one string through `execSync` (always shell-backed, on every
// platform) avoids that: this SQL contains only single quotes, so wrapping
// the whole thing in double quotes is unambiguous to both cmd.exe and bash,
// and every other interpolated value here is a fixed internal constant, not
// external input, so there is nothing to escape defensively.
function queryLanded() {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const sql = `SELECT event FROM events WHERE machine_id = '${CANARY_MACHINE_ID}' AND received_at > datetime('now', '-5 minutes')`
  const raw = execSync(`${npx} wrangler d1 execute ${DB_NAME} --remote --json --command "${sql}"`, {
    cwd: join(HERE, '..'),
    encoding: 'utf8',
  })
  return new Set(JSON.parse(raw)[0].results.map((r) => r.event))
}

const expected = new Set(events.map((e) => e.event))

// A fresh `wrangler deploy` is not instantly live on every edge node — found
// live 2026-08-05, right after Phase 2 shipped `model_load`: the first
// canary run immediately post-deploy quarantined it with "unknown event
// name", and re-running the exact same script unchanged 30 seconds later
// passed clean. Not a code bug — Cloudflare's own global rollout lag. Retry
// with backoff rather than trusting a single attempt, since a deploy script
// that cries wolf on its own propagation delay trains people to ignore it.
const MAX_ATTEMPTS = 4
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`canary: attempt ${attempt}/${MAX_ATTEMPTS} — posting ${events.length} events to ${ENDPOINT}`)
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Fresh timestamps each attempt, not the first attempt's frozen array —
    // an identical resend is harmless (D1 has no uniqueness constraint here
    // and these are already synthetic/excluded rows), and a fresh `ts` keeps
    // the "-5 minutes" query window honestly reflecting when THIS attempt ran.
    body: JSON.stringify(events.map((e) => ({ ...e, ts: new Date().toISOString() }))),
  })
  if (res.status !== 202) {
    console.error(`canary: FAIL — expected 202, got ${res.status}`)
    process.exit(1)
  }

  // D1 writes are awaited inside handleIngest before it responds, but this
  // query goes through a separate connection (wrangler's own D1 API client),
  // not the same request — a wait absorbs read-replica lag on top of
  // whatever's left of the edge-propagation delay above.
  await new Promise((r) => setTimeout(r, 5000))

  const landed = queryLanded()
  const missing = [...expected].filter((e) => !landed.has(e))
  if (missing.length === 0) {
    console.log(`canary: PASS — all ${expected.size} events landed in D1${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    console.log(`canary: remember these are synthetic — filter machineId='${CANARY_MACHINE_ID}' or app.version='${CANARY_VERSION}' out of any real analysis`)
    process.exit(0)
  }

  if (attempt === MAX_ATTEMPTS) {
    console.error(`canary: FAIL after ${MAX_ATTEMPTS} attempts — these events never reached D1: ${missing.join(', ')}`)
    console.error('This is the exact ADR-331 failure mode: check whether the deployed Worker actually')
    console.error('matches HEAD (npm run hash:check), and whether any of these were quarantined instead')
    console.error(`of accepted (SELECT * FROM quarantine WHERE machine_id = '${CANARY_MACHINE_ID}').`)
    process.exit(1)
  }

  console.log(`canary: ${missing.join(', ')} missing on attempt ${attempt} — retrying (edge propagation can lag briefly after deploy)`)
  await new Promise((r) => setTimeout(r, 10_000))
}
