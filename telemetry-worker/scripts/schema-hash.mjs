#!/usr/bin/env node
// The CI enforcement half of ADR-331/333's fix. The Worker inlines
// turbollm/src/telemetry/schema.ts at deploy time (index.ts imports it
// directly), so the live validator is whatever that file looked like at the
// LAST `wrangler deploy` — not at HEAD. That gap is exactly what silently
// dropped every `first_chat` event for two days: the schema changed, nobody
// redeployed, and nothing said so.
//
// This script is the mechanical fix. `write` records a hash of schema.ts
// alongside a real deploy; `check` (run in CI on every PR, unconditionally —
// it is a few milliseconds of local file hashing, not worth gating on which
// files changed) fails the build the moment schema.ts and the committed hash
// disagree. The fix for a failing check is always the same: redeploy the
// Worker (`npm run deploy` in this directory), which updates the hash file as
// part of the same command, then commit it alongside the schema change.
//
// Deliberately a raw file hash, not a hash of some derived "meaning" of the
// schema (e.g. only the exported enums). A byte-for-byte hash can never
// produce a false negative — any change that could possibly affect
// `validateEvent`'s behaviour changes some file in this set, so it always
// trips the gate. The cost is the inverse: a comment-only edit also trips
// it, forcing a deploy for zero behavioural change. That's an intentional
// trade — a slightly-too-eager gate that redeploys the Worker as a no-op is
// cheap; a gate that ever misses a real drift is the exact bug this exists
// to prevent.
//
// Hashes the WHOLE `telemetry/` source tree (every .ts file, tests
// excluded), not just schema.ts. Spec 24/ADR-333 (Phase 1) split what used
// to be one file into `schema.ts` (thin assembly) + `core/*.ts` (generic
// validator) + `events/*.ts` (the actual event definitions) — the Worker's
// bundle now transitively includes all of them via schema.ts's imports, so
// hashing schema.ts alone would silently stop catching a change to e.g.
// `events/model.ts`'s enum values, which is exactly the class of drift this
// gate exists to catch. `runtime/*.ts` (client-only: the typed emit helpers,
// the daily-rollup accumulator) is deliberately included too even though the
// Worker never imports it — a safe superset costs an occasional no-op
// redeploy, which is the accepted trade-off stated above.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const TELEMETRY_DIR = join(HERE, '..', '..', 'turbollm', 'src', 'telemetry')
const HASH_PATH = join(HERE, '..', 'deployed.schema.sha256')

function collectSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

function currentHash() {
  const files = collectSourceFiles(TELEMETRY_DIR).sort((a, b) => relative(TELEMETRY_DIR, a).localeCompare(relative(TELEMETRY_DIR, b)))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(TELEMETRY_DIR, file).replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

const mode = process.argv[2]

if (mode === 'write') {
  writeFileSync(HASH_PATH, currentHash() + '\n')
  console.log(`schema-hash: wrote ${HASH_PATH}`)
} else if (mode === 'check') {
  const deployed = readFileSync(HASH_PATH, 'utf8').trim()
  const actual = currentHash()
  if (deployed !== actual) {
    console.error(
      'schema-hash: turbollm/src/telemetry/schema.ts has changed since the telemetry Worker was last deployed.\n' +
        `  deployed hash: ${deployed}\n` +
        `  current hash:  ${actual}\n` +
        'Shipping this without redeploying the Worker means every event using the new shape is silently\n' +
        'rejected at the edge (ADR-331). Run `npm run deploy` in telemetry-worker/, then commit the\n' +
        'updated deployed.schema.sha256 alongside your schema.ts change.',
    )
    process.exit(1)
  }
  console.log('schema-hash: deployed Worker matches the current schema')
} else {
  console.error('usage: schema-hash.mjs <write|check>')
  process.exit(1)
}
