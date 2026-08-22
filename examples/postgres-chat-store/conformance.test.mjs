// examples/postgres-chat-store/conformance.test.mjs
//
// Runs the SAME conformance suite CI runs against SqliteChatStore (spec 27 §13)
// against this Postgres adapter, unmodified. This is the actual proof the adapter
// satisfies the ChatStore contract — the example's README and doc comments are not
// a substitute for this passing.
//
// Interim import approach (plan ruling R4-1, .superpowers/sdd/2026-08-18-external-
// chat-api-phase4/progress.md): this file lives in examples/, outside the turbollm/
// package, and imports the conformance suite via a relative path straight into
// turbollm/src/chat/store/conformance.ts. There is no published
// `@turbollm/chat-store-conformance` npm package yet (spec §14 defers that to Phase
// 5) — that is why this is a relative monorepo import rather than a real package
// dependency, and why this file is run through `tsx` (see package.json's `test`
// script: `tsx --test conformance.test.mjs`), not plain `node --test`: tsx is what
// lets a `.mjs` file resolve a `.js`-specifier import into a real `.ts` source, the
// same TS-aware ESM resolution every other test in this repo already relies on.
//
// Requires a running Postgres reachable at DATABASE_URL (see docker-compose.yml and
// README.md) with schema.sql already applied.
import { after } from 'node:test'
import { runConformanceSuite } from '../../turbollm/src/chat/store/conformance.js'
import createPostgresChatStore from './index.mjs'

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://turbollm:turbollm@localhost:5432/turbollm_chat_example'

// One pool, reused by every factory() call the suite makes — cheaper than opening a
// fresh connection per assertion, and it is what lets `after()` below close cleanly
// so `tsx --test` actually exits instead of hanging on an open handle.
const store = await createPostgresChatStore({ connectionString: DATABASE_URL })

after(async () => {
  await store.close()
})

runConformanceSuite('postgres', async () => ({
  store,
  // No per-call teardown: every test creates its own chat(s) with a fresh random
  // id, so accumulated rows across tests never collide. The shared pool is closed
  // once, in the after() hook above, not per-Harness.
  cleanup: () => {},
}))
