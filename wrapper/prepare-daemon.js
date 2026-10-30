// prepare-daemon.js — build the daemon + web UI if they aren't already built.
// electron-builder's extraResources (electron-builder.config.cjs) reads
// turbollm/dist and turbollm/node_modules directly at package time — this
// script only makes sure those exist before packaging runs, and that node-pty's
// macOS spawn-helper can run (makePtySpawnHelpersExecutable below).
const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const TURBOLLM_ROOT = join(__dirname, '..', 'turbollm')
const DIST_DIR = join(TURBOLLM_ROOT, 'dist')
const WEBDIST = join(DIST_DIR, 'webdist')

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

function main () {
  if (!existsSync(join(TURBOLLM_ROOT, 'node_modules'))) {
    console.log('Installing turbollm daemon dependencies...')
    run('npm', ['ci'], TURBOLLM_ROOT)
  }

  if (!existsSync(join(DIST_DIR, 'cli.js')) || !existsSync(WEBDIST)) {
    console.log('Building TurboLLM daemon + web UI...')
    run('npm', ['run', 'build:web'], TURBOLLM_ROOT)
    run('npm', ['run', 'build'], TURBOLLM_ROOT)
  } else {
    console.log('✓ turbollm/dist already built (delete it to force a rebuild)')
  }

  for (const helper of makePtySpawnHelpersExecutable(join(TURBOLLM_ROOT, 'node_modules'))) {
    console.log(`✓ made ${helper} executable`)
  }

  console.log('✓ Daemon ready for packaging')
}

module.exports = { makePtySpawnHelpersExecutable }

if (require.main === module) main()
