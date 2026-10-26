// node-pty's spawn-helper on macOS. node-pty starts a pty's program there through a small helper binary
// (posix_spawn of `<the directory its pty.node loaded from>/spawn-helper`, which sets the terminal up and execs the
// program), and node-pty 1.1.0's npm package ships its prebuilt helpers (prebuilds/darwin-arm64 and darwin-x64)
// without their exec bit: the tarball has them 0644, so npm installs them 0644, and every pty on a Mac failed with
// node-pty's bare "posix_spawnp failed.": every Code terminal and interactive routine terminal (both are
// PTYSession), from npm, `npm start` and the desktop app alike. Linux and Windows run no helper.
//
// So before its first pty a process makes the helper node-pty will run executable, when it is not: once, and that
// file only. Where it cannot be (an install it may not write to: a global install by root, the app run from its
// read-only disk image), that is logged once and the spawn goes ahead, failing as before.
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** The helpers already looked at in this process. */
const checked = new Set<string>()

export interface PtySpawnHelperOptions {
  platform?: NodeJS.Platform | 'android'
  arch?: string
  /** node-pty's package directory; by default the one this process loads. */
  ptyDir?: string
  chmod?: (path: string, mode: number) => void
  log?: (line: string) => void
}

/** The spawn-helper node-pty runs: the one beside the first pty.node its loader finds (lib/utils.js
 *  loadNativeModule: build/Release, build/Debug, then prebuilds/<platform>-<arch>, each relative to lib/.. and then
 *  to lib/; unixTerminal.js takes the helper from that same directory). Null without a pty.node. */
export function ptySpawnHelperPath(ptyDir: string, platform: string, arch: string): string | null {
  const lib = join(ptyDir, 'lib')
  for (const dir of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    for (const base of ['..', '.']) {
      const native = join(lib, base, dir)
      if (existsSync(join(native, 'pty.node'))) return join(native, 'spawn-helper')
    }
  }
  return null
}

/** On macOS, make the spawn-helper node-pty will run executable if it is not (adding an exec bit wherever the file
 *  has a read bit: 0644 becomes 0755). Call it before spawning a pty; only the first call per helper does anything. */
export function ensurePtySpawnHelper(opts: PtySpawnHelperOptions = {}): void {
  if ((opts.platform ?? process.platform) !== 'darwin') return
  let ptyDir = opts.ptyDir
  if (ptyDir === undefined) {
    try { ptyDir = dirname(require.resolve('node-pty/package.json')) } catch { return /* no node-pty: no terminals */ }
  }
  const helper = ptySpawnHelperPath(ptyDir, 'darwin', opts.arch ?? process.arch)
  if (helper === null || checked.has(helper)) return
  checked.add(helper)
  try {
    accessSync(helper, constants.X_OK)
    return
  } catch { /* not executable (or missing, which the stat below says) */ }
  try {
    const mode = statSync(helper).mode & 0o7777
    ;(opts.chmod ?? chmodSync)(helper, mode | ((mode & 0o444) >> 2))
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message
    ;(opts.log ?? console.warn)(`[terminal] node-pty's spawn-helper is not executable and could not be made so (${why}): ` +
      `terminals cannot start until it is (chmod +x '${helper}')`)
  }
}
