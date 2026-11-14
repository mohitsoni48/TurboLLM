// terminal-service.ts: the terminal accessors services use without importing the route module (scalability review 5.4).
// The seeding, launch-command and createAgentTerminal behavior is terminal-routes.test.ts's, which drives the same
// functions; here is what moving them must keep.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'
import * as routes from './terminal-routes'
import { getTerminalManager, isTerminalBackendAvailable } from './terminal-service'

const HERE = dirname(fileURLToPath(import.meta.url))

test('getTerminalManager answers the one manager for every caller, the route module included', () => {
  const d = { store: { dir: () => tmpDir('terminal-service-') } } as unknown as Deps
  assert.equal(getTerminalManager(d), getTerminalManager(d))
  assert.equal(routes.getTerminalManager(d), getTerminalManager(d), 'the deprecated route-module export is the same function')
  assert.equal(routes.isTerminalBackendAvailable, isTerminalBackendAvailable)
})

test('the services that spawn terminals take them from terminal-service, not from the route module', () => {
  for (const rel of ['../routines/execute.ts', '../routines/cli-interactive-runner.ts', '../boot.ts']) {
    const source = readFileSync(join(HERE, rel), 'utf8')
    const accessors = /import \{[^}]*\b(getTerminalManager|createAgentTerminal|firstMessageSeedProblem|CreateAgentTerminalResult)\b[^}]*\} from '[^']*terminal-routes'/
    assert.doesNotMatch(source, accessors, `${rel} imports a terminal accessor from terminal-routes`)
  }
})
