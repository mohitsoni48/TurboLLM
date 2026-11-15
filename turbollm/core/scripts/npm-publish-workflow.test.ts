// Run from turbollm/: npx tsx --test core/scripts/npm-publish-workflow.test.ts (rust-core plan T20, arch 2.8).
// GitHub Actions cannot run here, so this pins the structure of .github/workflows/npm-publish.yml: the core is built at
// the tag, the 9 platform packages are published and seen on the registry before `turbollm` is, and the published
// package is installed and loaded on four systems. A separate file from workflows.test.ts (core-build.yml, ci.yml).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const NPM_PUBLISH = join(REPO_ROOT, '.github', 'workflows', 'npm-publish.yml')
const RELEASE_TAG = 'github.event.release.tag_name || inputs.tag'
const CORE_ON = "vars.PUBLISH_NATIVE_CORE == 'true'"

interface Step {
  name?: string
  id?: string
  if?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

interface Job {
  if?: string
  needs?: string | string[]
  uses?: string
  with?: Record<string, unknown>
  'runs-on'?: string
  'timeout-minutes'?: number
  strategy?: { matrix: { os?: string[] } }
  outputs?: Record<string, string>
  steps?: Step[]
}

interface Workflow {
  on: { release: { types: string[] }; workflow_dispatch: { inputs: Record<string, unknown> } }
  permissions: Record<string, string>
  jobs: Record<string, Job>
}

const workflow = parse(readFileSync(NPM_PUBLISH, 'utf8')) as Workflow
const { core, publish } = workflow.jobs

function stepIndex(job: Job, matches: (step: Step) => boolean, what: string): number {
  const index = (job.steps ?? []).findIndex(matches)
  assert.ok(index >= 0, `no step that ${what}`)
  return index
}

const runs = (command: string) => (step: Step) => step.run?.includes(command) === true

function verifyJobs(): Job[] {
  return Object.entries(workflow.jobs)
    .filter(([name]) => name.startsWith('verify-published'))
    .map(([, job]) => job)
}

test('npm-publish keeps its triggers and the OIDC permission', () => {
  assert.deepEqual(workflow.on.release.types, ['published'])
  assert.ok('tag' in workflow.on.workflow_dispatch.inputs)
  assert.equal(workflow.permissions['id-token'], 'write')
  assert.equal(workflow.permissions.contents, 'read')
})

test('no npm token anywhere: the publish authenticates by OIDC only', () => {
  assert.doesNotMatch(JSON.stringify(workflow), /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./)
})

test('the core is built by the reusable workflow, as a release, at the release tag', () => {
  assert.equal(core.uses, './.github/workflows/core-build.yml')
  assert.equal(core.with?.release, true)
  assert.equal(core.with?.ref, `\${{ ${RELEASE_TAG} }}`)
  assert.equal(core.if, `startsWith(${RELEASE_TAG}, 'v') && ${CORE_ON}`)
})

test('jobs run in the order core, publish, verify-published', () => {
  assert.deepEqual(Object.keys(workflow.jobs).slice(0, 2), ['core', 'publish'])
  assert.deepEqual([publish.needs].flat(), ['core'])
  const verify = verifyJobs()
  assert.ok(verify.length > 0, 'no verify-published job')
  for (const job of verify) assert.deepEqual([job.needs].flat(), ['publish'])
})

test('publish downloads every core-node artifact into one flat folder', () => {
  const download = publish.steps?.[stepIndex(publish, (s) => s.uses?.startsWith('actions/download-artifact@') === true, 'downloads artifacts')]
  assert.equal(download?.with?.pattern, 'core-node-*')
  assert.equal(download?.with?.['merge-multiple'], true)
  assert.equal(download?.with?.path, '${{ runner.temp }}/core-node')
})

test('publish orders platform packages, the registry gate and the inject before the turbollm publish', () => {
  const download = stepIndex(publish, (s) => s.uses?.startsWith('actions/download-artifact@') === true, 'downloads')
  const platform = stepIndex(publish, runs('node core/scripts/publish-platform-packages.mjs'), 'publishes platform packages')
  const gate = stepIndex(publish, runs('node core/scripts/await-platform-packages.mjs'), 'waits for the registry')
  const inject = stepIndex(publish, runs('node core/scripts/inject-optional-deps.mjs'), 'injects the optional deps')
  const turbollm = stepIndex(publish, (s) => s.run?.trim() === 'npm publish --provenance', 'publishes turbollm')
  assert.ok(download < platform && platform < gate && gate < inject && inject < turbollm, 'steps out of order')
  const steps = publish.steps ?? []
  assert.match(steps[platform]?.run ?? '', /--version "?\$\{\{ steps\.version\.outputs\.version \}\}"? --artifacts "?\$\{\{ runner\.temp \}\}\/core-node"?/)
  assert.match(steps[gate]?.run ?? '', /--version "?\$\{\{ steps\.version\.outputs\.version \}\}"?/)
  assert.match(steps[inject]?.run ?? '', /inject-optional-deps\.mjs "?\$\{\{ steps\.version\.outputs\.version \}\}"?/)
  assert.equal(publish.outputs?.version, '${{ steps.version.outputs.version }}')
})

// qa-tasks E-45: re-running after a complete release publishes nothing and does not fail; npm refuses a second
// publish of the same version, so the turbollm publish must be skipped, not attempted.
test('a re-run skips the inject and the turbollm publish when the registry already has that version', () => {
  const check = stepIndex(publish, (s) => s.id === 'published', 'checks whether turbollm is already published')
  const inject = stepIndex(publish, runs('node core/scripts/inject-optional-deps.mjs'), 'injects the optional deps')
  const turbollm = stepIndex(publish, (s) => s.run?.trim() === 'npm publish --provenance', 'publishes turbollm')
  const steps = publish.steps ?? []
  assert.ok(check < inject, 'the registry check must come before the inject')
  assert.match(steps[check]?.run ?? '', /npm view "turbollm@\$VERSION" version/)
  assert.match(steps[check]?.run ?? '', /published=true/)
  assert.match(steps[check]?.run ?? '', /published=false/)
  assert.match(steps[check]?.run ?? '', />> "\$GITHUB_OUTPUT"/)
  assert.equal(steps[check]?.env?.VERSION, '${{ steps.version.outputs.version }}')
  const notYetPublished = "steps.published.outputs.published != 'true'"
  assert.equal(steps[inject]?.if, `${notYetPublished} && ${CORE_ON}`)
  assert.equal(steps[turbollm]?.if, notYetPublished)
})

test('verify-published still runs on a re-run that published nothing', () => {
  for (const job of verifyJobs()) assert.equal(job.if, undefined)
})

test('verify-published installs the release on Windows, macOS, Linux and Alpine', () => {
  const systems = verifyJobs().flatMap((job) => {
    const matrix = job.strategy?.matrix.os
    if (matrix !== undefined) return matrix
    return (job.steps ?? []).some(runs('node:22-alpine')) ? ['node:22-alpine'] : [job['runs-on'] ?? '']
  })
  assert.deepEqual(systems.sort(), ['macos-latest', 'node:22-alpine', 'ubuntu-latest', 'windows-latest'])
})

test('every verify job installs with retries, runs the installed bin and loads its platform package', () => {
  assert.ok(verifyJobs().length > 0, 'no verify-published job')
  for (const job of verifyJobs()) {
    const script = (job.steps ?? []).map((s) => s.run ?? '').join('\n')
    assert.match(script, /npm install -g "turbollm@\$VERSION"/)
    assert.match(script, /for attempt in/)
    assert.match(script, /turbollm --help/)
    assert.match(script, /node core\/scripts\/verify-installed-core\.mjs --version "\$VERSION"/)
    for (const step of job.steps ?? []) {
      if (step.run?.includes('$VERSION')) assert.equal(step.env?.VERSION, '${{ needs.publish.outputs.version }}')
    }
  }
})

test('every job but the reusable core call sets timeout-minutes', () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (job.uses !== undefined) continue
    assert.ok(Number.isInteger(job['timeout-minutes']), `${name} has no timeout-minutes`)
  }
})

// Release 1.15.2: the @turbollm npm org and the 9 trusted publishers do not exist yet, so the native core is off until
// PUBLISH_NATIVE_CORE is set. With it unset turbollm must still publish on its own and the verify jobs must not load a
// platform package that was never published.
test('with PUBLISH_NATIVE_CORE unset the core steps are skipped but turbollm still publishes', () => {
  assert.match(publish.if ?? '', /needs.core.result == 'skipped'/)
  assert.match(publish.if ?? '', /needs.core.result == 'success'/)
  const gated = [
    (s: Step) => s.uses?.startsWith('actions/download-artifact@') === true,
    runs('node core/scripts/publish-platform-packages.mjs'),
    runs('node core/scripts/await-platform-packages.mjs'),
    runs('node core/scripts/inject-optional-deps.mjs'),
  ]
  for (const matches of gated) {
    const step = publish.steps?.[stepIndex(publish, matches, 'is a core step')]
    assert.ok(step?.if?.includes(CORE_ON), `${step?.name} is not gated on PUBLISH_NATIVE_CORE`)
  }
  const turbollm = publish.steps?.[stepIndex(publish, (s) => s.run?.trim() === 'npm publish --provenance', 'publishes turbollm')]
  assert.ok(!turbollm?.if?.includes('PUBLISH_NATIVE_CORE'), 'the turbollm publish must not depend on the core')
})

test('the verify jobs load the platform package only when the core is on', () => {
  const [matrixJob, alpineJob] = verifyJobs()
  const load = matrixJob?.steps?.find(runs('verify-installed-core.mjs'))
  assert.ok(load?.if?.includes(CORE_ON), 'the matrix verify load step is not gated')
  const alpine = alpineJob?.steps?.find(runs('node:22-alpine'))
  assert.equal(alpine?.env?.NATIVE_CORE, '${{ vars.PUBLISH_NATIVE_CORE }}')
  assert.match(alpine?.run ?? '', /if \[ "\$NATIVE_CORE" = true \]; then node core\/scripts\/verify-installed-core\.mjs/)
})
