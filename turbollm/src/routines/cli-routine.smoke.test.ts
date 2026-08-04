// The ONE real, non-mocked end-to-end test for CLI-flavor Code Routine execution (spec 21 §2).
// Shells out to the REAL `claude` binary against a REAL, already-running TurboLLM daemon.
//
// Gated behind ROUTINE_CLI_SMOKE=1 — it is a no-op in default CI and in the default `npm test`
// (which globs `src/**/*.test.ts`, this file included): with the flag unset the single test is
// reported SKIPPED, nothing is spawned, and no network call is made. Everything with a side
// effect — the temp-dir ConversationStore, the CLI probe, the subprocess — lives INSIDE the test
// body for exactly that reason; nothing at module scope touches the filesystem or the network.
//
// It does NOT start a daemon itself, matching spec 21 §2's "manual/local pass" framing.
// Requirements for a real run:
//   1. The real CLI installed and on PATH:  npm install -g @anthropic-ai/claude-code
//   2. A real TurboLLM daemon already running, with a model loaded, on ROUTINE_CLI_SMOKE_PORT
//      (default 6996).
//   3. From turbollm/:
//        ROUTINE_CLI_SMOKE=1 npx tsx --test src/routines/cli-routine.smoke.test.ts
//      PowerShell: $env:ROUTINE_CLI_SMOKE='1'; npx tsx --test src/routines/cli-routine.smoke.test.ts
//
// This is the step that closes the plan's one open technical question: `cli-output.ts` parses a
// stream-json shape taken from the CLI's DOCUMENTED headless contract, never measured against a
// real binary. If a real run's output doesn't match, fix `cli-output.ts` and re-run this.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { GenerationGate } from '../agents/gate'
import { runCliCodeRoutine, type CliRoutineDeps } from './cli-routine'
import { isClaudeCliAvailable } from './cli-preflight'
import { realSpawnCliProcess, runClaudeCliProcess } from './cli-process'
import { claudePermissionModeChoices } from '../terminal/agent-modes'

const RUN_SMOKE = process.env.ROUTINE_CLI_SMOKE === '1'
const PORT = Number(process.env.ROUTINE_CLI_SMOKE_PORT ?? 6996)
/** Whatever the running daemon actually has loaded. Only used for ANTHROPIC_MODEL and to make the
 *  model-conflict decision resolve to 'run' — this test deliberately does not exercise swapping. */
const MODEL_KEY = process.env.ROUTINE_CLI_SMOKE_MODEL ?? 'smoke-test-does-not-pin-a-specific-model'

test(
  'real claude CLI, real local gateway: a trivial prompt returns a real, parsed result',
  { skip: RUN_SMOKE ? false : 'set ROUTINE_CLI_SMOKE=1 to run this real-subprocess smoke test' },
  async () => {
    assert.equal(await isClaudeCliAvailable(), true, 'the claude CLI must be installed on PATH for this smoke test')

    const store = new ConversationStore(mkdtempSync(join(tmpdir(), 'cli-routine-smoke-')))
    const created = store.createRoutine({
      flavor: 'code',
      prompt: 'Reply with exactly the words: smoke test ok',
      scheduleDisplay: 'manual smoke test',
      scheduleRule: { kind: 'interval', everyMs: 60_000 },
      modelKey: MODEL_KEY,
      workspacePath: process.cwd(),
      codingAgent: 'claude_cli',
      permissionMode: 'plan',
    })
    const routine = store.confirmRoutine(created.id, new Date().toISOString()) ?? created

    const deps: CliRoutineDeps = {
      store,
      gate: new GenerationGate(),
      // No swap path here: reporting the pinned model as already loaded makes decideModelAction
      // return 'run', so this goes straight to spawning the real CLI. Swap/restore is covered
      // exhaustively by cli-routine.test.ts; this test is about the real subprocess and the real
      // stream-json output.
      getLoadedModelKey: () => routine.modelKey,
      // Production wires this to `engineIsIdle(manager)`; this test has no Manager of its own (it
      // talks to an ALREADY-RUNNING daemon over HTTP), and the 'run' decision above means the value
      // is never acted on — nothing here can swap a model.
      getEngineIdle: () => true,
      loadExplicit: async () => ({ target: `http://127.0.0.1:${PORT}` }),
      now: () => new Date(),
      port: PORT,
      isAvailable: () => isClaudeCliAvailable(),
      // The REAL probe against the REAL installed binary — the whole point of this test is that
      // nothing in the chain is faked.
      permissionModeChoices: () => claudePermissionModeChoices(),
      // Real spawn AND the real kill-tree default: this is an actual OS process, so the tree
      // sweep must be able to reach it.
      runProcess: (args, opts) => runClaudeCliProcess(args, opts, realSpawnCliProcess),
    }

    await runCliCodeRoutine(routine, deps)

    const runs = store.listRoutineRuns(routine.id)
    assert.equal(runs.length, 1)
    const run = runs[0]
    console.log('[smoke] real claude CLI run:', JSON.stringify({ status: run.status, skipReason: run.skipReason, result: run.result, error: run.error }, null, 2))
    assert.ok(
      run.status === 'ok' || run.status === 'errored',
      `expected a real, non-skipped outcome (got ${run.status} / ${run.skipReason})`,
    )
    assert.ok(run.endedAt, 'a finished run must always be stamped with endedAt')
    // If this fires, `cli-output.ts` did not recognise the real binary's stream-json output — see
    // this file's header. The message is deliberately loud about that being the likely cause.
    assert.equal(
      run.status,
      'ok',
      `the real run did not succeed — if the error below looks like raw CLI output rather than a real failure, cli-output.ts's assumed stream-json shape is wrong:\n${run.error}`,
    )
    // Deliberately NOT an exact-wording match: what is under test is the CLI's stream-json
    // contract and this orchestrator's plumbing, not whether whichever local model the daemon
    // happens to have loaded follows an instruction literally.
    assert.ok((run.result ?? '').trim().length > 0, 'a successful run must store a non-empty result')
  },
)
