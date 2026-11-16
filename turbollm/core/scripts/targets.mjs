// The one table of npm targets for the native core (rust-core plan P-9). The build, stage and
// publish scripts and the CI workflow test read it; src/native/load.ts's SUPPORTED_TARGETS must
// list the same suffixes in the same order (load.test.ts checks).
//
// suffix: the npm package suffix and the `.node` file infix (`@turbollm/core-<suffix>`).
// os, cpu, libc: the platform package's package.json fields (libc only narrows Linux).
// runner: the GitHub-hosted runner that builds this target natively, or the cross-build host (core-build.yml's
// node-addon matrix must name the same runner; workflows.test.ts checks).

export const NPM_TARGETS = Object.freeze([
  { suffix: 'win32-x64-msvc', triple: 'x86_64-pc-windows-msvc', os: 'win32', cpu: 'x64', libc: null, runner: 'windows-latest' },
  { suffix: 'win32-arm64-msvc', triple: 'aarch64-pc-windows-msvc', os: 'win32', cpu: 'arm64', libc: null, runner: 'windows-11-arm' },
  { suffix: 'darwin-x64', triple: 'x86_64-apple-darwin', os: 'darwin', cpu: 'x64', libc: null, runner: 'macos-latest' },
  { suffix: 'darwin-arm64', triple: 'aarch64-apple-darwin', os: 'darwin', cpu: 'arm64', libc: null, runner: 'macos-latest' },
  { suffix: 'linux-x64-gnu', triple: 'x86_64-unknown-linux-gnu', os: 'linux', cpu: 'x64', libc: 'glibc', runner: 'ubuntu-latest' },
  { suffix: 'linux-arm64-gnu', triple: 'aarch64-unknown-linux-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc', runner: 'ubuntu-24.04-arm' },
  { suffix: 'linux-x64-musl', triple: 'x86_64-unknown-linux-musl', os: 'linux', cpu: 'x64', libc: 'musl', runner: 'ubuntu-latest' },
  { suffix: 'linux-arm64-musl', triple: 'aarch64-unknown-linux-musl', os: 'linux', cpu: 'arm64', libc: 'musl', runner: 'ubuntu-24.04-arm' },
  { suffix: 'android-arm64', triple: 'aarch64-linux-android', os: 'android', cpu: 'arm64', libc: null, runner: 'ubuntu-latest' },
])

/** The oldest glibc a linux-*-gnu binary may need (arch 2.7); `cargo xtask check-glibc --max` enforces it in CI. */
export const GLIBC_FLOOR = '2.28'

/**
 * The --target cargo-zigbuild gets for a Linux target: a glibc target carries the floor as a suffix, which zig reads
 * as the glibc version to link against; musl has no version to pin.
 */
export function crossCompileTriple(target) {
  return target.libc === 'glibc' ? `${target.triple}.${GLIBC_FLOOR}` : target.triple
}

/** The target this machine runs, or undefined when no npm target matches it. */
export function hostTarget() {
  const libc = process.platform === 'linux' ? hostLibc() : null
  return NPM_TARGETS.find((t) => t.os === process.platform && t.cpu === process.arch && t.libc === libc)
}

function hostLibc() {
  return process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'
}

/** The npm package that ships one target's binary. */
export function platformPackageName(suffix) {
  return `@turbollm/core-${suffix}`
}

/** The binary's file name, in the CI artifact and in the platform package. */
export function binaryFileName(suffix) {
  return `turbollm-core.${suffix}.node`
}
