// Run from turbollm/: npx tsx --test core/scripts/workflows.test.ts (rust-core plan T18).
// GitHub Actions cannot run here, so this pins the structure of .github/workflows/core-build.yml: the target matrix
// against targets.mjs, the artifact names of arch 5.7, and the steps the earlier tasks left for CI to run.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { GLIBC_FLOOR, NPM_TARGETS } from './targets.mjs'

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_BUILD = join(CORE_DIR, '..', '..', '.github', 'workflows', 'core-build.yml')
const CORPUS_HASH = "hashFiles('turbollm/core/fixtures/gguf/corpus.json')"
const CORPUS_FETCH = 'node core/scripts/fetch-gguf-corpus.mjs'
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  with?: Record<string, unknown>
  'working-directory'?: string
}

interface Job {
  'runs-on': string
  'timeout-minutes'?: number
  strategy?: { matrix: { include?: Record<string, unknown>[] } }
  steps: Step[]
}

interface Workflow {
  on: Record<string, { inputs?: Record<string, { type: string }> }>
  env?: Record<string, string>
  jobs: Record<string, Job>
}

const workflow = parse(readFileSync(CORE_BUILD, 'utf8')) as Workflow
const jobs = workflow.jobs

test('core-build is only a reusable workflow, with a boolean release input', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call'])
  assert.equal(workflow.on.workflow_call.inputs?.release?.type, 'boolean')
})

test('core-build has the five jobs of arch 2.7', () => {
  assert.deepEqual(Object.keys(jobs).sort(), [
    'android-emulator',
    'android-library',
    'node-addon',
    'nodejs-mobile-addon',
    'rust-checks',
  ])
})

test('every job sets timeout-minutes', () => {
  for (const [name, job] of Object.entries(jobs)) {
    assert.ok(Number.isInteger(job['timeout-minutes']), `${name} has no timeout-minutes`)
  }
})

test('the node-addon matrix is the targets.mjs table: suffix, triple and runner', () => {
  const entries = nodeAddonEntries().map(({ target, triple, runner }) => ({ target, triple, runner }))

  assert.deepEqual(
    entries,
    NPM_TARGETS.map(({ suffix, triple, runner }) => ({ target: suffix, triple, runner })),
  )
})

test('every node-addon target missing from rust-toolchain.toml gets rustup target add first', () => {
  const missing = nodeAddonEntries().filter((entry) => !toolchainTargets().includes(String(entry.triple)))
  const addTarget = stepRunning(jobs['node-addon'], 'rustup target add ${{ matrix.triple }}')
  const build = stepRunning(jobs['node-addon'], 'core/scripts/build-node.mjs')

  assert.ok(missing.length > 0, 'the toolchain file lists every target; this test would prove nothing')
  assert.equal(addTarget.if, undefined, 'rustup target add must run for every matrix entry')
  assert.ok(stepIndex(jobs['node-addon'], addTarget) < stepIndex(jobs['node-addon'], build))
})

test('the Linux targets are cross-built with zig, and the glibc ones are checked against the floor', () => {
  const linux = nodeAddonEntries().filter((entry) => String(entry.triple).includes('-linux-'))
  const glibcCheck = stepRunning(jobs['node-addon'], 'cargo xtask check-glibc')

  for (const entry of linux.filter((e) => !String(e.triple).endsWith('-android'))) {
    assert.equal(entry.zig, true, `${entry.target} is not built with cargo-zigbuild`)
  }
  assert.match(String(glibcCheck.run), new RegExp(`--max ${GLIBC_FLOOR.replace('.', '\\.')} `))
  assert.match(String(glibcCheck.if), /gnu/)
})

test('the musl targets are tested in node:22-alpine and Android is build only', () => {
  const testsByTarget = Object.fromEntries(nodeAddonEntries().map((entry) => [entry.target, entry.tests]))
  const alpineRun = stepRunning(jobs['node-addon'], 'node:22-alpine')

  assert.equal(testsByTarget['linux-x64-musl'], 'alpine')
  assert.equal(testsByTarget['linux-arm64-musl'], 'alpine')
  assert.equal(testsByTarget['android-arm64'], 'none')
  assert.match(String(alpineRun.if), /alpine/)
  const buildOnly = stepRunning(jobs['node-addon'], 'build only')
  assert.ok(buildOnly.if?.includes("'none'"))
  assert.equal(buildOnly.name, 'No tests (cross-built target)')
})

// The differential test against the TS parser was deleted with it (rust-core T22): the goldens are the spec.
test('every runnable node-addon target runs the loader and golden tests against its binary, and no parity test', () => {
  for (const tests of ['host', 'alpine']) {
    const run = stepsRunning(jobs['node-addon'], 'src/native/gguf.golden.test.ts')
      .filter((step) => String(step.if).includes(`'${tests}'`))
      .map((step) => String(step.run))
      .join('\n')
    assert.match(run, /src\/native\/load\.test\.ts/, `${tests}: load.test.ts`)
    assert.doesNotMatch(run, /gguf\.parity/, `${tests}: gguf.parity.test.ts is deleted`)
  }
})

test('artifact names match arch 5.7', () => {
  assert.deepEqual(uploadedArtifacts('node-addon'), [
    { name: 'core-node-${{ matrix.target }}', path: 'turbollm/core/bindings/node/turbollm-core.${{ matrix.target }}.node' },
  ])
  assert.deepEqual(
    uploadedArtifacts('nodejs-mobile-addon').map((artifact) => artifact.name),
    ['core-nodejs-mobile-arm64-v8a', 'core-nodejs-mobile-x86_64'],
  )
  assert.deepEqual(
    uploadedArtifacts('android-library').map((artifact) => artifact.name),
    ['core-android-aar'],
  )
})

test('rust-checks runs the whole Rust gate, the script tests and the binding drift check', () => {
  const run = allRuns(jobs['rust-checks'])

  for (const command of [
    'cargo fmt --all --check',
    'cargo clippy --workspace --all-targets -- -D warnings',
    'cargo deny check',
    'cargo xtask check-version',
    'cargo xtask goldens-check',
    'cargo test --workspace',
    'npx tsx --test --test-timeout=60000 "core/scripts/*.test.ts"',
    'git diff --exit-code -- src/native/binding.generated.d.ts',
  ]) {
    assert.ok(run.includes(command), `rust-checks does not run: ${command}`)
  }
})

test('every job that runs the goldens fetches the corpus first, from a cache keyed on corpus.json', () => {
  for (const name of ['rust-checks', 'node-addon', 'android-library', 'android-emulator']) {
    const job = jobs[name]
    const cache = job.steps.find((step) => step.uses?.startsWith('actions/cache@'))
    const fetch = stepRunning(job, CORPUS_FETCH)

    assert.ok(cache, `${name} restores no corpus cache`)
    assert.ok(String(cache.with?.key).includes(CORPUS_HASH), `${name}: cache key is not the corpus.json hash`)
    assert.ok(stepIndex(job, cache) < stepIndex(job, fetch), `${name}: fetch runs before the cache restore`)
  }
})

test('android-library builds the AAR, runs the JVM goldens and minifies the R8 consumer', () => {
  const run = allRuns(jobs['android-library'])

  for (const task of [':turbollm-core:assembleRelease', ':turbollm-core:testDebugUnitTest', ':r8-consumer:assembleRelease']) {
    assert.ok(run.includes(task), `android-library does not run ${task}`)
  }
  assert.ok(run.includes('chmod +x'), 'gradlew is not executable in git')
})

test('android-emulator runs both instrumented suites on an x86_64 API 34 emulator', () => {
  const emulator = jobs['android-emulator'].steps.find((step) =>
    step.uses?.startsWith('reactivecircus/android-emulator-runner@'),
  )

  assert.ok(emulator, 'no emulator step')
  assert.equal(emulator.with?.['api-level'], 34)
  assert.equal(emulator.with?.arch, 'x86_64')
  assert.match(String(emulator.with?.script), /:turbollm-core:connectedDebugAndroidTest/)
  assert.match(String(emulator.with?.script), /:r8-consumer:connectedReleaseAndroidTest/)
})

// GITHUB_SHA is the caller's commit, not inputs.ref, so a dispatched release build would report main's sha (review
// S2). build.rs prefers TURBOLLM_GIT_SHA, which every job sets from the commit it actually checked out.
test('every job records the checked-out commit as TURBOLLM_GIT_SHA right after its checkout', () => {
  for (const [name, job] of Object.entries(jobs)) {
    const checkout = job.steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'))
    const record = job.steps[checkout + 1]
    assert.ok(checkout >= 0, `${name}: no checkout`)
    assert.equal(record?.run?.trim(), 'echo "TURBOLLM_GIT_SHA=$(git rev-parse HEAD)" >> "$GITHUB_ENV"', name)
    assert.equal(record?.shell, 'bash', `${name}: the record step must not depend on the runner's default shell`)
  }
})

test('first-party actions use a major tag and every other action a full commit sha', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const uses of job.steps.flatMap((step) => (step.uses ? [step.uses] : []))) {
      const [action, ref] = uses.split('@')
      const pinned = action.startsWith('actions/') ? /^v\d+$/.test(ref) : FULL_COMMIT_SHA.test(ref)
      assert.ok(pinned, `${name}: ${uses} is not pinned`)
    }
  }
})

function nodeAddonEntries(): Record<string, unknown>[] {
  return jobs['node-addon'].strategy?.matrix.include ?? []
}

function toolchainTargets(): string[] {
  const toolchain = readFileSync(join(CORE_DIR, 'rust-toolchain.toml'), 'utf8')
  const list = /^targets\s*=\s*\[(.*)\]/m.exec(toolchain)?.[1] ?? ''
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function uploadedArtifacts(jobName: string): { name: unknown; path: unknown }[] {
  return jobs[jobName].steps
    .filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
    .map((step) => ({ name: step.with?.name, path: step.with?.path }))
}

function stepRunning(job: Job, text: string): Step {
  const [step] = stepsRunning(job, text)
  assert.ok(step, `no step runs ${text}`)
  return step
}

function stepsRunning(job: Job, text: string): Step[] {
  return job.steps.filter((step) => step.run?.includes(text))
}

function stepIndex(job: Job, step: Step): number {
  return job.steps.indexOf(step)
}

function allRuns(job: Job): string {
  return job.steps.map((step) => step.run ?? '').join('\n')
}

// T19: ci.yml calls core-build.yml on every PR, and the jobs that run daemon code from source load the binary it built.
const CI = join(CORE_DIR, '..', '..', '.github', 'workflows', 'ci.yml')
const BINDINGS_DIR = 'turbollm/core/bindings/node'
const JOBS_THAT_LOAD_THE_CORE = ['android-bundle', 'tether', 'unit', 'unit-windows']
const HOST_TARGET_OF_RUNNER: Record<string, string> = {
  'ubuntu-latest': 'linux-x64-gnu',
  'windows-latest': 'win32-x64-msvc',
  'macos-latest': 'darwin-arm64',
}

interface CiJob {
  name?: string
  'runs-on'?: string
  uses?: string
  with?: Record<string, unknown>
  needs?: string | string[]
  strategy?: { matrix: Record<string, unknown> }
  steps?: Step[]
}

const ciJobs = (parse(readFileSync(CI, 'utf8')) as { jobs: Record<string, CiJob> }).jobs

test('ci.yml keeps the job names branch protection requires', () => {
  const names = Object.fromEntries(
    ['test', 'unit', 'unit-windows', 'web', 'android-bundle', 'release-script', 'ts-client', 'tether', 'wrapper'].map(
      (id) => [id, ciJobs[id]?.name],
    ),
  )

  assert.deepEqual(names, {
    test: 'Typecheck & Lint',
    unit: 'Unit tests (${{ matrix.shard }})',
    'unit-windows': 'Unit tests (Windows smoke)',
    web: 'Web build & unit tests',
    'android-bundle': 'Android bundle build',
    'release-script': 'Release script tests',
    'ts-client': 'TS client typecheck & tests',
    tether: 'Process tether (${{ matrix.os }})',
    wrapper: 'Desktop wrapper unit tests',
  })
})

test('ci.yml has a core job that calls core-build.yml as a PR build, not a release build', () => {
  const core = ciJobs.core

  assert.ok(core, 'ci.yml has no core job')
  assert.equal(core.uses, './.github/workflows/core-build.yml')
  assert.notEqual(core.with?.release, true)
})

test('exactly the jobs that run daemon code from source need core; web does not', () => {
  const needingCore = Object.keys(ciJobs).filter((id) => needsOf(ciJobs[id]).includes('core'))

  assert.deepEqual(needingCore.sort(), JOBS_THAT_LOAD_THE_CORE)
  assert.ok(!needsOf(ciJobs.web).includes('core'))
})

test("each core-loading job downloads its own runner's core-node artifact into the loader's source-build dir", () => {
  for (const id of JOBS_THAT_LOAD_THE_CORE) {
    const job = ciJobs[id]
    const download = coreDownloadStep(id)

    assert.equal(download.with?.path, BINDINGS_DIR, `${id}: wrong download path`)
    for (const combo of matrixCombos(job)) {
      const runner = expand(String(job['runs-on']), combo)
      const expected = `core-node-${HOST_TARGET_OF_RUNNER[runner]}`
      assert.equal(expand(String(download.with?.name), combo), expected, `${id} on ${runner}`)
    }
    assert.ok(stepIndex(job as Job, download) < firstTestStepIndex(id), `${id}: tests run before the download`)
  }
})

test('the jobs that only download the core install no Rust toolchain', () => {
  for (const id of JOBS_THAT_LOAD_THE_CORE) {
    for (const step of ciJobs[id].steps ?? []) {
      assert.ok(!step.run?.includes('rustup') && !step.run?.includes('cargo'), `${id}: ${step.run}`)
      assert.ok(!step.uses?.includes('rust'), `${id}: ${step.uses}`)
    }
  }
})

test("the unit job's rest shard fetches the GGUF corpus, from the rust-checks cache key, before its tests", () => {
  const unit = ciJobs.unit as Job
  const cache = unit.steps.find((step) => step.uses?.startsWith('actions/cache@'))
  const fetch = stepRunning(unit, CORPUS_FETCH)
  const rustChecksCache = jobs['rust-checks'].steps.find((step) => step.uses?.startsWith('actions/cache@'))

  assert.ok(cache, 'unit restores no corpus cache')
  assert.deepEqual(cache.with, rustChecksCache?.with)
  for (const step of [cache, fetch]) {
    assert.match(String(step.if), /matrix\.shard == 'rest'/)
  }
  assert.ok(stepIndex(unit, cache) < stepIndex(unit, fetch))
  assert.ok(stepIndex(unit, fetch) < firstTestStepIndex('unit'))
})

test('ci.yml pins first-party actions to a major tag', () => {
  for (const [id, job] of Object.entries(ciJobs)) {
    for (const uses of (job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : []))) {
      assert.match(uses, /^actions\/[a-z-]+@v\d+$/, `${id}: ${uses}`)
    }
  }
})

function needsOf(job: CiJob): string[] {
  return [job.needs ?? []].flat()
}

function coreDownloadStep(id: string): Step {
  const downloads = (ciJobs[id].steps ?? []).filter((step) => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(downloads.length, 1, `${id}: expected one artifact download`)
  return downloads[0]
}

function firstTestStepIndex(id: string): number {
  return (ciJobs[id].steps ?? []).findIndex((step) => /npx tsx --test|npx tsup/.test(step.run ?? ''))
}

/** Every combination a job's matrix runs: one list-valued key, each value merged with the `include` entries for it. */
function matrixCombos(job: CiJob): Record<string, unknown>[] {
  const { include = [], ...axes } = (job.strategy?.matrix ?? {}) as Record<string, unknown> & {
    include?: Record<string, unknown>[]
  }
  const [axis] = Object.keys(axes)
  if (!axis) return [{}]
  return (axes[axis] as unknown[]).map((value) => {
    const extra = include.filter((entry) => entry[axis] === value)
    return Object.assign({ [axis]: value }, ...extra)
  })
}

function expand(text: string, combo: Record<string, unknown>): string {
  return text.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, key: string) => String(combo[key]))
}

// T23: the installers are built from a source checkout, so desktop-release builds the host's native core before the
// daemon (`npm run build` stages it into dist/native/, which electron-builder.config.cjs copies into the app).
const DESKTOP_RELEASE = join(CORE_DIR, '..', '..', '.github', 'workflows', 'desktop-release.yml')
const desktopBuild = (parse(readFileSync(DESKTOP_RELEASE, 'utf8')) as Workflow).jobs.build

test('desktop-release builds the native core before the daemon', () => {
  const buildCore = stepRunning(desktopBuild, 'npm run build:core')
  const buildDaemon = desktopBuild.steps.find((step) => /^npm run build$/m.test(step.run ?? ''))

  assert.ok(buildDaemon, 'no step runs npm run build')
  assert.equal(buildCore.if, undefined, 'build:core must run on every installer OS')
  assert.ok(allRuns(desktopBuild).indexOf('npm run build:core') < allRuns(desktopBuild).search(/^npm run build$/m))
})

test('desktop-release installs the pinned Rust toolchain and caches the core workspace before building it', () => {
  const toolchain = stepRunning(desktopBuild, 'rustup toolchain install')
  const cache = desktopBuild.steps.find((step) => step.uses?.startsWith('Swatinem/rust-cache@'))
  const buildCore = stepRunning(desktopBuild, 'npm run build:core')

  assert.equal((toolchain as Step & { 'working-directory'?: string })['working-directory'], 'turbollm/core')
  assert.ok(cache, 'no Swatinem/rust-cache step')
  assert.equal(cache.with?.workspaces, 'turbollm/core', 'the cache is keyed on turbollm/core/Cargo.lock')
  assert.ok(stepIndex(desktopBuild, toolchain) < stepIndex(desktopBuild, buildCore))
  assert.ok(stepIndex(desktopBuild, cache) < stepIndex(desktopBuild, buildCore))
})

// The AppImage ships the core too, so it must keep the glibc 2.28 floor of arch 2.3: on Linux, desktop-release builds
// it exactly as core-build.yml's linux-x64-gnu row does (zig cross-build pinned to the floor) and checks it.
const LINUX_BINARY = 'turbollm-core.linux-x64-gnu.node'
const LINUX_ONLY = "${{ runner.os == 'Linux' }}"
const desktopRelease = parse(readFileSync(DESKTOP_RELEASE, 'utf8')) as Workflow

for (const action of ['mlugg/setup-zig@', 'taiki-e/install-action@']) {
  test(`desktop-release sets up ${action} on Linux only, pinned as core-build does, before the core build`, () => {
    const pinned = coreBuildStepUsing(action)
    const setup = desktopBuild.steps.find((step) => step.uses?.startsWith(action))

    assert.ok(setup, `no ${action} step`)
    assert.equal(setup.uses, pinned.uses, 'same commit sha as core-build.yml')
    assert.deepEqual(setup.with, pinned.with, 'same tool and version input as core-build.yml')
    assert.equal(setup.if, LINUX_ONLY)
    assert.ok(stepIndex(desktopBuild, setup) < stepIndex(desktopBuild, stepRunning(desktopBuild, 'npm run build:core')))
  })
}

test('desktop-release pins the same zig and cargo-zigbuild versions as core-build', () => {
  for (const name of ['ZIG_VERSION', 'CARGO_ZIGBUILD_VERSION']) {
    assert.ok(workflow.env?.[name], `core-build.yml has no ${name}`)
    assert.equal(desktopRelease.env?.[name], workflow.env?.[name], name)
  }
})

test('desktop-release cross-builds the Linux core against the glibc floor', () => {
  const buildCore = stepRunning(desktopBuild, 'npm run build:core')

  assert.ok(
    buildCore.run?.includes("${{ runner.os == 'Linux' && '-- --target linux-x64-gnu --cross-compile' || '' }}"),
    'on Linux the core build must pass --target linux-x64-gnu --cross-compile',
  )
})

test('desktop-release checks the Linux core needs no glibc newer than the floor before packaging', () => {
  const checkGlibc = stepRunning(desktopBuild, 'cargo xtask check-glibc')
  const packageInstaller = stepRunning(desktopBuild, 'npm run package')

  assert.equal(checkGlibc.run, `cargo xtask check-glibc --max ${GLIBC_FLOOR} bindings/node/${LINUX_BINARY}`)
  assert.equal(checkGlibc['working-directory'], 'turbollm/core')
  assert.equal(checkGlibc.if, LINUX_ONLY)
  assert.ok(stepIndex(desktopBuild, stepRunning(desktopBuild, 'npm run build:core')) < stepIndex(desktopBuild, checkGlibc))
  assert.ok(stepIndex(desktopBuild, checkGlibc) < stepIndex(desktopBuild, packageInstaller))
})

function coreBuildStepUsing(action: string): Step {
  const step = jobs['node-addon'].steps.find((candidate) => candidate.uses?.startsWith(action))
  assert.ok(step, `core-build.yml node-addon has no ${action} step`)
  return step
}

// T23: the release images build the Linux binary themselves, in a Rust stage pinned to rust-toolchain.toml, and the
// Node build stage stages it into dist/native/ through `npm run build`. Docker cannot run here; this pins the order.

for (const image of ['Dockerfile.nvidia', 'Dockerfile.amd']) {
  test(`${image} builds the linux-x64-gnu core in a pinned Rust stage and stages it before npm run build`, () => {
    const lines = dockerfileLines(image)
    const rustStage = lines.findIndex((line) => line === `FROM rust:${toolchainChannel()}-bookworm AS core`)
    const coreBuild = lines.findIndex((line) => line.includes('build-node.mjs --target linux-x64-gnu --release'))
    const nodeStage = lines.findIndex((line) => /^FROM node:\S+ AS build$/.test(line))
    const sourceCopy = lines.findIndex((line) => line === 'COPY turbollm/ ./')
    const binaryCopy = lines.findIndex(
      (line) => line === `COPY --from=core /src/core/bindings/node/${LINUX_BINARY} ./core/bindings/node/`,
    )
    const daemonBuild = lines.findIndex((line) => line === 'RUN npm run build')

    assert.ok(rustStage >= 0, `no FROM rust:${toolchainChannel()}-bookworm AS core stage`)
    assert.ok(
      lines.includes(`ENV RUSTUP_TOOLCHAIN=${toolchainChannel()}`),
      'RUSTUP_TOOLCHAIN must name the rust-toolchain.toml channel, or rustup silently fetches another toolchain',
    )
    assert.ok(rustStage < coreBuild && coreBuild < nodeStage, 'the Rust stage builds the core before the Node stage')
    assert.ok(sourceCopy < binaryCopy && binaryCopy < daemonBuild, 'the binary lands after the source, before build')
    assert.ok(!lines.some((line) => /win32|msvc/.test(line)), 'no Windows binary goes into a Linux image')
  })
}

function dockerfileLines(name: string): string[] {
  return readFileSync(join(CORE_DIR, '..', '..', name), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
}

function toolchainChannel(): string {
  const toolchain = readFileSync(join(CORE_DIR, 'rust-toolchain.toml'), 'utf8')
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1]
  assert.ok(channel, 'rust-toolchain.toml has no channel')
  return channel
}

// T23d (QA PG-10): npm treats a failed optional-dependency fetch as a warning, so the RunPod image must load the
// platform package's binary at build time, or it would build green and exit 69 on every pod start.
test('the RunPod image loads @turbollm/core-linux-x64-gnu and calls coreInfo() right after installing turbollm', () => {
  const lines = dockerfileLines(join('deploy', 'runpod', 'Dockerfile'))
  const install = lines.indexOf('RUN npm install -g turbollm')
  const loadCheck = instructionAfter(lines, install)

  assert.ok(install >= 0, 'the RunPod image no longer installs turbollm from npm')
  // The published turbollm@1.15.1 has no --version flag: calling it boots the daemon and hangs the build.
  assert.match(loadCheck, /^RUN node -e /)
  assert.doesNotMatch(loadCheck, /turbollm --version/)
  assert.match(loadCheck, /process\.dlopen\([^)]*\)/)
  assert.match(loadCheck, /resolve\('@turbollm\/core-linux-x64-gnu'\)/)
  assert.match(loadCheck, /\.coreInfo\(\)\.version/)
  assert.match(loadCheck, /\$\(npm root -g\)\/turbollm\/package\.json/, 'resolved from the global turbollm install')
})

test('the RunPod image build job is bounded by timeout-minutes', () => {
  const runpodImage = join(CORE_DIR, '..', '..', '.github', 'workflows', 'runpod-image.yml')
  const buildAndPush = (parse(readFileSync(runpodImage, 'utf8')) as Workflow).jobs['build-and-push']

  assert.ok(Number.isInteger(buildAndPush['timeout-minutes']), 'build-and-push has no timeout-minutes')
})

/** The Dockerfile instruction after line `index`, comments and blank lines skipped, continuation lines joined. */
function instructionAfter(lines: string[], index: number): string {
  const rest = lines.slice(index + 1).filter((line) => line !== '' && !line.startsWith('#'))
  const end = rest.findIndex((line) => !line.endsWith('\\'))
  return rest.slice(0, end + 1).join('\n')
}
