// Puts the Linux core into a host-built dist/ before a QA image COPYs it (rust-core plan T23b, QA PG-4, P-12).
// Dockerfile.test, Dockerfile.test.gpu and Dockerfile.test-port take turbollm/dist from the host, whose own build
// staged the host's binary (win32 on the founder's box); building Rust inside those images OOMs the test VM.
//
//   node core/scripts/stage-linux-binary.mjs [<package root>] --from-artifact <dir> | --from-build
//
// --from-artifact: <dir> holds the CI artifact core-node-linux-x64-gnu of the same commit
//                  (gh run download <run-id> -n core-node-linux-x64-gnu -D <dir>).
// --from-build:    builds it here with build-node.mjs --cross-compile (needs cargo-zigbuild and zig on PATH).
// Either way the file must be an x86-64 ELF shared object carrying this package version's marker (P-11).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { binaryFileName } from './targets.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PACKAGE_ROOT = join(SCRIPTS_DIR, '..', '..')
const LINUX_TARGET = 'linux-x64-gnu'
const LINUX_BINARY = binaryFileName(LINUX_TARGET)
const USAGE = 'usage: node core/scripts/stage-linux-binary.mjs [<package root>] --from-artifact <dir>|--from-build'
const USAGE_EXIT_CODE = 2
const FAILURE_EXIT_CODE = 1

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const ELF_CLASS_64 = 2
const ELF_LITTLE_ENDIAN = 1
const ELF_SHARED_OBJECT = 3
const ELF_MACHINE_X86_64 = 62

const request = parseRequest(process.argv.slice(2))
const binaryPath = request.fromBuild ? buildLinuxBinary() : artifactBinary(request.artifactDir)
stageLinuxBinary(request.root, binaryPath)

function parseRequest(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { 'from-artifact': { type: 'string' }, 'from-build': { type: 'boolean', default: false } },
    allowPositionals: true,
  })
  const artifactDir = values['from-artifact']
  if ((artifactDir === undefined) === !values['from-build']) refuse(USAGE)
  return { root: positionals[0] ?? DEFAULT_PACKAGE_ROOT, artifactDir, fromBuild: values['from-build'] }
}

function artifactBinary(artifactDir) {
  const binary = join(artifactDir, LINUX_BINARY)
  if (!existsSync(binary)) {
    fail(
      `${binary} does not exist. Download the CI artifact of this commit first:\n` +
        `  gh run download <run-id> -n core-node-linux-x64-gnu -D <dir>`,
    )
  }
  return binary
}

function buildLinuxBinary() {
  const build = spawnSync(
    process.execPath,
    [join(SCRIPTS_DIR, 'build-node.mjs'), '--target', LINUX_TARGET, '--release', '--cross-compile'],
    { stdio: 'inherit' },
  )
  if (build.status !== 0) fail(`build-node.mjs --target ${LINUX_TARGET} failed; is cargo-zigbuild installed?`)
  return join(SCRIPTS_DIR, '..', 'bindings', 'node', LINUX_BINARY)
}

function stageLinuxBinary(root, binary) {
  const bytes = readFileSync(binary)
  refuseUnlessX86_64SharedObject(binary, bytes)
  refuseUnlessVersion(binary, bytes, packageVersion(root))
  mkdirSync(join(root, 'dist', 'native'), { recursive: true })
  copyFileSync(binary, join(root, 'dist', 'native', LINUX_BINARY))
  console.log(`staged dist/native/${LINUX_BINARY}`)
}

function refuseUnlessX86_64SharedObject(binary, bytes) {
  if (bytes.length < 20 || !bytes.subarray(0, 4).equals(ELF_MAGIC)) fail(`${binary} is not an ELF file`)
  const isX86_64SharedObject =
    bytes[4] === ELF_CLASS_64 &&
    bytes[5] === ELF_LITTLE_ENDIAN &&
    bytes.readUInt16LE(16) === ELF_SHARED_OBJECT &&
    bytes.readUInt16LE(18) === ELF_MACHINE_X86_64
  if (!isX86_64SharedObject) fail(`${binary} is not an x86-64 ELF shared object`)
}

function refuseUnlessVersion(binary, bytes, version) {
  const marker = `TURBOLLM_CORE_VERSION=${version}`
  if (!bytes.includes(Buffer.from(`${marker}\0`))) fail(`${binary} has no ${marker} marker: it is another build`)
}

function packageVersion(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

function refuse(message) {
  console.error(`stage-linux-binary: ${message}`)
  process.exit(USAGE_EXIT_CODE)
}

function fail(message) {
  console.error(`stage-linux-binary: ${message}`)
  process.exit(FAILURE_EXIT_CODE)
}
