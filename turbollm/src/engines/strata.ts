import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { GpuVendor } from '../sysinfo/sysinfo'
import { downloadFile, extractArchive, type ProvisionProgress } from './download'
import { driverMaxCuda, nvidiaComputeCaps } from './nvidia-smi'

// v0.2.13 is the last upstream release with the DeepSeek V4.1 engine.
export const STRATA_VERSION = 'v0.2.13'
const BASE = 'https://github.com/Niko1221/Strata/releases/download/' + STRATA_VERSION
const run = promisify(execFile)
const adapter = fileURLToPath(new URL('./strata-run.py', import.meta.url))

const packages = {
  'win32-x64': ['windows-x86_64', 'c81f6800094942a5e750c7d93f348062bc16484f946ea83b0c0d2f8c91c44e87', '1ae0f2d7c820e5b5b3c02cdafc86dbdddb6d7a66aa4bde70309a3e78aa714d2c'],
  'linux-x64': ['linux-x86_64', '73fb612848cf00fa1072623029b35405bbbb63e3f4c688fe6f38c78e3fc022ac', '4440a62b6aaf51d740f8c37fcc0e7b28cf79ba37aaa199a214b98067c5bf36ad'],
  'linux-arm64': ['linux-aarch64', '1579f7c6490e52334ca2d134b81534e6a5a351247a506918cbfd1f8285114523', '55f2607d4dc06311aafe335e8b84664c8eecc93376d8a1b59c806f298017749c'],
  'darwin-arm64': ['macos-arm64', '62e571b58d60d6507e5d24975f380ae0f2c302210e895ad31fc166b59c18d024', '2fcbd44259db297782b0bdf54065b65a3882a0f52723b12940fdff40b928013d'],
} as const

export function strataPackages(vendor: GpuVendor, platform = process.platform, arch = process.arch) {
  const entry = packages[`${platform}-${arch}` as keyof typeof packages]
  if (!entry || vendor !== (platform === 'darwin' ? 'apple' : 'nvidia')) return null
  const [target, controlHash, engineHash] = entry
  const version = target === 'linux-x86_64' ? '0.1.59.1' : '0.1.59'
  return [
    { name: `strata-control-${version}-${target}.${platform === 'win32' ? 'zip' : 'tar.gz'}`, digest: controlHash, dir: 'control' },
    { name: `strata-dsv41-0.1.59-${target}-${platform === 'darwin' ? 'metal' : 'cuda-cuda13'}.tar.gz`, digest: engineHash, dir: 'engine' },
  ]
}

export function strataBinPath(root: string) {
  return join(root, 'strata', STRATA_VERSION, 'control', 'strata.py')
}

function python(control: string) {
  return join(control, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
}

export async function installStrata(root: string, vendor: GpuVendor, progress: (p: ProvisionProgress) => void, signal: AbortSignal) {
  const assets = strataPackages(vendor)
  if (!assets) throw new Error('Strata needs an NVIDIA CUDA 13 GPU on Windows x64 or Linux x64/arm64, or an Apple Silicon Mac.')
  const bin = strataBinPath(root)
  const parent = join(root, 'strata')
  if (vendor === 'nvidia') {
    const [cuda, caps] = await Promise.all([driverMaxCuda(), nvidiaComputeCaps()])
    if (cuda && Number.parseFloat(cuda) < 13) throw new Error('The Strata package requires a CUDA 13 driver.')
    if (process.arch === 'x64' && caps.length && !caps.some(cc => cc === 8.6 || cc === 8.9 || cc >= 12)) {
      throw new Error('The Strata x64 CUDA package supports compute capabilities 8.6, 8.9 and 12.0 or newer.')
    }
  }
  if (existsSync(bin)) return bin
  await mkdir(parent, { recursive: true })
  const temp = await mkdtemp(join(parent, '.install-'))
  try {
    for (const [i, asset] of assets.entries()) {
      const archive = join(temp, asset.name)
      const dest = join(temp, asset.dir)
      await mkdir(dest)
      await downloadFile(`${BASE}/${asset.name}`, archive, p => progress({ ...p, part: i + 1, parts: assets.length }), signal, fetch, { expectedSha256: asset.digest })
      signal.throwIfAborted()
      const windowsTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      if (asset.name.endsWith('.zip') && process.platform === 'win32' && existsSync(windowsTar)) {
        // The control zip contains a complete Python distribution. System bsdtar handles its long paths.
        await run(windowsTar, ['-xf', asset.name, '-C', asset.dir], { cwd: temp, windowsHide: true, signal })
      } else {
        await extractArchive(archive, dest)
      }
      await rm(archive)
    }
    const control = join(temp, 'control')
    const engine = join(temp, 'engine', process.platform === 'win32' ? 'strata-dsv41.exe' : 'strata-dsv41')
    if (![python(control), join(control, 'strata.py'), engine].every(p => existsSync(p))) throw new Error('Incomplete Strata release archive.')
    signal.throwIfAborted()
    await rename(temp, join(parent, STRATA_VERSION))
    return bin
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export function strataCommand(bin: string, model: string, mode: 'check' | 'serve', port = 0, context = 8192) {
  const control = dirname(bin)
  return { cmd: python(control), args: ['-I', '-u', adapter, mode, control, model, String(port), String(context || 8192)] }
}

export async function checkStrataModel(bin: string, model: string) {
  const { cmd, args } = strataCommand(bin, model, 'check')
  try {
    await run(cmd, args, { timeout: 60_000, windowsHide: true })
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim()
    throw new Error(detail || 'Strata could not inspect the selected GGUF.')
  }
}
