// prepare-daemon.js — build the daemon + web UI if they aren't already built.
// electron-builder's extraResources (electron-builder.config.cjs) reads
// turbollm/dist and turbollm/node_modules directly at package time — this
// script only makes sure those exist before packaging runs.
const { existsSync } = require('node:fs')
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

console.log('✓ Daemon ready for packaging')
