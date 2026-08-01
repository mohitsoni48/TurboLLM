// Source-level guard: every operation on the files a Code session's agent edits must resolve its
// directory through `agentCwd(run)`, never `run.repoRoot` directly.
//
// ── Why a source scan and not a behavioural test ─────────────────────────────────────────────
// This defends against a specific, already-made mistake that no unit test would have caught. The
// first version of worktrees switched `git status`/`commit`/`push`/`revert` to the worktree but
// left the site EVERY ordinary turn goes through (`runs.enqueue`/`steer` in POST .../messages)
// on `run.repoRoot`. The result was worse than not having the feature: the agent edited the user's
// real working tree while commits targeted an empty worktree and silently did nothing. It was
// caught by the pre-release review gate, and cost this feature its place in v1.9.6.
//
// The failure mode is "a NEW call site forgets the helper" — invisible to any test of the existing
// ones, and only reachable end-to-end through a live model turn. A source scan catches it at the
// point it is introduced. Precedent in this repo: web/src/screens/code/no-stray-hex.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTES = readFileSync(join(HERE, 'code-routes.ts'), 'utf8')

/** Calls whose directory argument decides WHICH TREE is read or written. Each must be handed
 *  `agentCwd(run)`. Adding a new one of these? It belongs in this list. */
const OPERATIONAL_CALLS = [
  'runShellCommand(',
  'getGitStatus(',
  'getGithubCompareUrl(',
  'commitGitChanges(',
  'pushGitBranch(',
  'revertFileEdits(',
  'agentsMdPresence(',
]

/** Lines that legitimately use `run.repoRoot`, because they are about the PROJECT, not the tree
 *  the agent edits:
 *   - the sidebar/detail payload (the project is what identifies the session)
 *   - `if (!run.repoRoot)` guards (does this session have a repo at all?)
 *   - `removeSessionWorktree(run.repoRoot, …)` — `git worktree remove` MUST run from the base repo
 *   - the `run.worktreePath && run.repoRoot` guard that precedes it */
function isLegitimateRepoRootUse(line: string): boolean {
  const t = line.trim()
  return (
    t.startsWith('if (!run.repoRoot)') ||
    t.startsWith('repoRoot: run.repoRoot ??') ||
    t.startsWith('hasAgentsMd: run.repoRoot') ||
    t.includes('removeSessionWorktree(run.repoRoot') ||
    t.startsWith('if (run.worktreePath && run.repoRoot)')
  )
}

test('every operational call in code-routes.ts uses agentCwd(run), not run.repoRoot', () => {
  const offenders: string[] = []
  ROUTES.split('\n').forEach((line, i) => {
    for (const call of OPERATIONAL_CALLS) {
      if (!line.includes(call)) continue
      // The directory argument is on this line for every current call site.
      if (line.includes('run.repoRoot')) offenders.push(`${i + 1}: ${line.trim()}`)
    }
  })
  assert.deepEqual(offenders, [], `these must use agentCwd(run):\n${offenders.join('\n')}`)
})

test('the turn enqueue path passes agentCwd — the exact site that shipped wrong', () => {
  // `runs.enqueue`/`runs.steer` receive `enqueueParams`, which becomes the pi agent's cwd AND its
  // containment root. This is the single most important line in the feature.
  const line = ROUTES.split('\n').find((l) => l.includes('const enqueueParams'))
  assert.ok(line, 'enqueueParams must still exist — if it was renamed, update this test')
  assert.ok(
    line.includes('repoRoot: agentCwd(run)'),
    `the agent's own turn must run in the worktree, got:\n  ${line.trim()}`,
  )
})

test('no unaccounted-for run.repoRoot remains in code-routes.ts', () => {
  // A catch-all, so a NEW use has to be consciously classified rather than slipping in. If you are
  // adding a legitimate project-level use, add it to isLegitimateRepoRootUse above.
  const unexpected = ROUTES.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('run.repoRoot') && !isLegitimateRepoRootUse(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`)
  assert.deepEqual(unexpected, [], `classify these as project-level or switch them to agentCwd:\n${unexpected.join('\n')}`)
})

test('the PTY cwd uses agentCwd too — both agents must see the same tree', () => {
  const terminal = readFileSync(join(HERE, '..', 'terminal', 'terminal-routes.ts'), 'utf8')
  const create = terminal.split('\n').find((l) => l.includes('m.create('))
  assert.ok(create, 'terminal creation call must still exist')
  assert.ok(
    create.includes('agentCwd(run)'),
    `the CLI must open in the same tree the in-app agent edits, got:\n  ${create.trim()}`,
  )
})
