// electron-builder.config.cjs — installer config for the TurboLLM desktop wrapper.
//
// Dynamic (not a static package.json "build" block) so it can resolve the build
// machine's own Node binary at config-eval time. The daemon needs a REAL Node.js
// process — not Electron's embedded one via ELECTRON_RUN_AS_NODE — because
// node-pty (the terminal-agent PTY feature) is a native addon prebuilt against
// stock Node's ABI, and node:sqlite needs a Node build that has it. Whichever
// Node is currently running this config (the dev's own install locally, or
// actions/setup-node's provisioned version in CI) is exactly the one that just
// built turbollm/'s node_modules, so it's always the correct match for this
// platform/arch.
const { join } = require('node:path')

const TURBOLLM_ROOT = join(__dirname, '..', 'turbollm')
const nodeBinaryName = process.platform === 'win32' ? 'node.exe' : 'node'

module.exports = {
  appId: 'dev.turbollm.desktop',
  productName: 'TurboLLM',
  copyright: 'Mohit Soni',
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  // Allowlist, not default include-everything: wrapper/dist (build output) and
  // wrapper/build (icon source, build-time only) must NOT end up inside the
  // packaged app.
  //
  // node_modules IS shipped now: `electron-updater` is a real runtime
  // dependency of main.js (auto-update), so it has to exist inside the asar.
  // electron-builder resolves the *production* dependency tree itself, so the
  // devDependencies (electron, electron-builder) are still excluded — only the
  // ~16 packages under `electron-updater` come along.
  files: ['main.js', 'package.json', 'node_modules/**/*'],
  // Emit latest.yml / latest-linux.yml / latest-mac.yml + .blockmap files
  // alongside the installers. Without a publish provider electron-builder
  // generates no update manifests at all, and electron-updater cannot work.
  // Nothing is auto-published from here — desktop-release.yml uploads the
  // artifacts onto the already-created GitHub release with `gh release upload`.
  publish: [{ provider: 'github', owner: 'mohitsoni48', repo: 'TurboLLM' }],
  extraResources: [
    { from: join(TURBOLLM_ROOT, 'dist'), to: 'daemon/dist' },
    { from: join(TURBOLLM_ROOT, 'bin'), to: 'daemon/bin' },
    { from: join(TURBOLLM_ROOT, 'node_modules'), to: 'daemon/node_modules' },
    { from: join(TURBOLLM_ROOT, 'package.json'), to: 'daemon/package.json' },
    { from: process.execPath, to: nodeBinaryName },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    artifactName: 'TurboLLM-Setup-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
  },
  // Native-arch-only for now (no cross-arch build): the bundled Node binary
  // above is resolved from THIS build machine, so a multi-arch build would
  // ship a mismatched node binary inside the other arch's package. GitHub's
  // macos-latest runner is arm64 (Apple Silicon) — an Intel-mac build is a
  // follow-up, not solved here (see docs/TODO.md).
  mac: {
    target: [{ target: 'dmg' }],
    icon: 'build/icon.png',
    category: 'public.app-category.developer-tools',
  },
  dmg: {
    artifactName: 'TurboLLM-${arch}.${ext}',
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    icon: 'build/icon.png',
    category: 'Development',
    artifactName: 'TurboLLM-${arch}.${ext}',
  },
}
