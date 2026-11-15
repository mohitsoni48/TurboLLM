// prepare-daemon.js — build the native core, and the daemon + web UI if they aren't already built.
// electron-builder's extraResources (electron-builder.config.cjs) reads
// turbollm/dist and turbollm/node_modules directly at package time — this
// script only makes sure those exist before packaging runs, and that node-pty's
// macOS spawn-helper can run (makePtySpawnHelpersExecutable below).
const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const TURBOLLM_ROOT = join(__dirname, '..', 'turbollm')

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}  (in ${cwd})`)
  // No untrusted input reaches this — every arg here is a fixed literal, so
  // shell:true (needed on Windows to resolve npm.cmd) carries no injection risk.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

/** node-pty starts a terminal's shell on macOS through its spawn-helper, and
 *  node-pty 1.1.0's npm package ships the prebuilt ones (prebuilds/darwin-arm64,
 *  darwin-x64) without their exec bit, so npm installs them 0644. extraResources
 *  copies the daemon's node_modules into the app with each file's mode as it is,
 *  so the app's Code terminals failed with "posix_spawnp failed.", and the daemon
 *  cannot always fix it there itself (an app run from its read-only disk image).
 *  Adds an exec bit wherever such a helper has a read bit (0644 becomes 0755);
 *  returns the helpers it changed. Nothing else is touched. */
function makePtySpawnHelpersExecutable (nodeModules) {
  const prebuilds = join(nodeModules, 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) return []
  const changed = []
  for (const dir of readdirSync(prebuilds)) {
    if (!dir.startsWith('darwin-')) continue
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (!existsSync(helper)) continue
    const mode = statSync(helper).mode & 0o7777
    const wanted = mode | ((mode & 0o444) >> 2)
    if (wanted === mode) continue
    chmodSync(helper, wanted)
    changed.push(helper)
  }
  return changed
}

/** Builds whatever the installer needs from turbollm/. The native core is rebuilt on every run (QA PG-7): a dist
 *  built before the core existed has no dist/native/, and electron-builder would package it as it is. */
function prepareDaemon (steps) {
  if (steps.hostBinaryName === undefined) {
    steps.fail(`no native core target for ${process.platform}-${process.arch}: this machine cannot build an installer.`)
    return
  }
  const hostBinary = `dist/native/${steps.hostBinaryName}`
  if (!steps.exists('node_modules')) {
    steps.log('Installing turbollm daemon dependencies...')
    steps.run('npm', ['ci'])
  }
  steps.run('npm', ['run', 'build:core'])
  if (isDaemonBuilt(steps, hostBinary)) {
    steps.log('✓ turbollm/dist already built (delete it to force a rebuild); staging the fresh native core')
    steps.run('node', ['core/scripts/stage-native.mjs'])
  } else {
    steps.log('Building TurboLLM daemon + web UI...')
    steps.run('npm', ['run', 'build:web'])
    steps.run('npm', ['run', 'build'])
  }
  if (!steps.exists(hostBinary)) refuseInstallerWithoutCore(steps, hostBinary)
}

function isDaemonBuilt (steps, hostBinary) {
  return ['dist/cli.js', 'dist/webdist', hostBinary].every((relativePath) => steps.exists(relativePath))
}

function refuseInstallerWithoutCore (steps, hostBinary) {
  steps.fail([
    `${hostBinary} is missing after the build: an installer without it would stop with exit 69 on launch.`,
    'Run: npm run build:core && npm run build',
  ].join('\n'))
}

async function main () {
  prepareDaemon({
    hostBinaryName: await hostBinaryName(),
    exists: (relativePath) => existsSync(join(TURBOLLM_ROOT, relativePath)),
    run: (cmd, args) => run(cmd, args, TURBOLLM_ROOT),
    fail: (message) => {
      console.error(message)
      process.exit(1)
    },
    log: (message) => console.log(message),
  })

  for (const helper of makePtySpawnHelpersExecutable(join(TURBOLLM_ROOT, 'node_modules'))) {
    console.log(`✓ made ${helper} executable`)
  }

  console.log('✓ Daemon ready for packaging')
}

/** targets.mjs is the one table of native targets (rust-core plan P-9); it is ESM, so it is imported. */
async function hostBinaryName () {
  const targets = await import(pathToFileURL(join(TURBOLLM_ROOT, 'core', 'scripts', 'targets.mjs')).href)
  const host = targets.hostTarget()
  return host === undefined ? undefined : targets.binaryFileName(host.suffix)
}

module.exports = { makePtySpawnHelpersExecutable, prepareDaemon }

if (require.main === module) main()
