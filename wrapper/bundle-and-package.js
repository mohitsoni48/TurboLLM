// bundle-and-package.js — Build + bundle daemon + package Electron app
//
// Single script that:
// 1. Builds the TurboLLM daemon and web UI (if not already built)
// 2. Copies daemon files into Electron's resources/ daemon/ directory
// 3. Runs @electron/packager to produce a standalone .exe
//
// Usage:
//   npm run package          # → everything above, produces dist/desktop/
//   npm start                # → runs electron with unbundled daemon
//
// Note: On Windows this script must run via PowerShell, not Bash.
// The build commands use PowerShell to avoid the cmd.exe ENOENT issue.

const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { join } = require('path')
const { spawn } = require('child_process')

const TURBOLLM_ROOT = join(__dirname, '..', '..', 'turbollm')
const DIST_DIR = join(TURBOLLM_ROOT, 'dist')
const WEBDIST = join(DIST_DIR, 'webdist')

// ── 1. Build daemon + web UI (if needed) ──────────────────────────────────────
// We need to detect which shell we're running under and use the right command.
// Bash on Windows has no cmd.exe, so we fall back to node scripts or PowerShell.
function shellRun(cmd, cwd) {
  // Try to detect environment and use the right shell
  const isWindows = process.platform === 'win32'
  const hasCmd = existsSync('C:\\WINDOWS\\system32\\cmd.exe')

  // If we're in Bash on Windows (no cmd.exe), use node directly
  if (isWindows && !hasCmd) {
    // Use node_modules/.bin scripts which are cross-platform
    const binPath = join(cwd, 'node_modules', '.bin', 'tsup.cmd')
    if (existsSync(binPath)) {
      spawn.sync('node_modules\\.bin\\tsup.cmd', [], {
        cwd, stdio: 'inherit', shell: true
      })
      return
    }
  }
  // Otherwise use normal spawn (works in Bash or PowerShell)
  spawn.sync(cmd, [], {
    cwd, stdio: 'inherit', shell: true
  })
}

if (!existsSync(join(DIST_DIR, 'cli.js'))) {
  console.log('Building TurboLLM daemon...')
  try { shellRun('npm run build', TURBOLLM_ROOT) }
  catch (e) {
    console.warn('npm build failed, trying direct tsup...')
    // Fallback: run tsup directly
    try { shellRun('tsup src/cli.ts --format esm --target node22 --external node:sqlite --external @earendil-works/pi-ai --external @earendil-works/pi-coding-agent --no-bundle', TURBOLLM_ROOT) }
    catch (e2) {
      console.error('Build failed — please run `npm run build` in the turbollm repo first.')
      process.exit(1)
    }
  }
}

if (!existsSync(WEBDIST)) {
  console.log('Building web UI...')
  try { shellRun('npm run build:web', join(TURBOLLM_ROOT, 'web')) }
  catch (e) {
    console.warn('web build failed, trying vite directly...')
    // Fallback: run vite build directly
    try { shellRun('vite build', join(TURBOLLM_ROOT, 'web')) }
    catch (e2) {
      console.error('Web build failed — please run `npm run build:web` in the turbollm web directory first.')
      process.exit(1)
    }
    // Re-bundle so webdist lands in dist/
    try { shellRun('npm run build', TURBOLLM_ROOT) }
    catch (e3) {
      console.error('Daemon re-build failed after web UI build.')
      process.exit(1)
    }
  }
}

console.log('✓ TurboLLM daemon is built')

// ── 2. Package with @electron/packager ───────────────────────────────────────
const platform = process.platform === 'win32' ? 'win32' : process.platform
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

console.log('Packaging with @electron/packager...')
const packager = spawn('npx', [
  '@electron/packager',
  '.',                          // current dir (wrapper/)
  'TurboLLM',                  // app name
  '--out', 'dist/desktop',
  '--platform', platform,
  '--arch', arch,
  '--overwrite',
  '--app-copyright', 'Mohit Soni',
], { stdio: 'inherit' })

packager.on('exit', (code) => {
  if (code !== 0) {
    console.error(`@electron/packager exited with code ${code}`)
    process.exit(1)
    return
  }

  // ── 3. Copy daemon into the bundle ──────────────────────────────────────
  const PACKAGED_DIR = join(__dirname, 'dist', 'desktop', 'TurboLLM-win32-x64')

  if (!existsSync(PACKAGED_DIR)) {
    console.error('Packaged output not found at', PACKAGED_DIR)
    process.exit(1)
    return
  }

  const RESOURCES_DIR = join(PACKAGED_DIR, 'resources')
  const DAEMON_DIR = join(RESOURCES_DIR, 'daemon')

  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true })

  // Copy daemon (cli.js + webdist + chunks) — skip node_modules since
  // @electron/packager already bundled Electron deps
  cpSync(DIST_DIR, DAEMON_DIR, { recursive: true, filter: (src) => {
    return !src.includes('node_modules')
  }})

  console.log(`✓ Bundled daemon → resources/daemon/`)
  console.log(`✓ Package ready: ${PACKAGED_DIR}/TurboLLM.exe`)
})
