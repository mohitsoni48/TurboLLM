// System info detection (spec 05 §6): GPU(s), CPU, RAM. Cached for the process
// lifetime. Used for VRAM-fit estimation, the settings UI, and engine-backend
// selection (ADR-025: vendor → fastest backend).
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown'

export interface GpuInfo {
  name: string
  vramMb: number
  vendor: GpuVendor
}
export interface SysInfo {
  os: string
  cpu: string
  cores: number
  ramMB: number
  gpus: GpuInfo[]
}

let cached: SysInfo | null = null

export function getSysInfo(): SysInfo {
  if (cached) return cached
  cached = {
    os: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0]?.model?.trim() ?? '',
    cores: os.cpus().length || 1,
    ramMB: Math.round(os.totalmem() / 1e6),
    gpus: detectGpus(),
  }
  return cached
}

/** The vendor that drives backend selection: first discrete GPU, else unknown. */
export function primaryVendor(info: SysInfo = getSysInfo()): GpuVendor {
  // Prefer a discrete accelerator over an integrated one (Intel iGPU alongside
  // an NVIDIA/AMD dGPU is common): rank nvidia/amd/apple above intel.
  const rank: Record<GpuVendor, number> = { nvidia: 4, amd: 3, apple: 3, intel: 2, unknown: 1 }
  let best: GpuVendor = 'unknown'
  for (const g of info.gpus) if (rank[g.vendor] > rank[best]) best = g.vendor
  return best
}

export function classifyVendor(name: string): GpuVendor {
  const n = name.toLowerCase()
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(n)) return 'nvidia'
  if (/amd|radeon|\brx\b|instinct|vega|firepro/.test(n)) return 'amd'
  if (/intel|arc|iris|\buhd\b|\bhd graphics\b/.test(n)) return 'intel'
  if (/apple/.test(n)) return 'apple'
  return 'unknown'
}

function detectGpus(): GpuInfo[] {
  // 1) NVIDIA (Windows/Linux): nvidia-smi gives exact name + VRAM.
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
      timeout: 8000,
      windowsHide: true,
    }).toString()
    const gpus = out
      .trim()
      .split('\n')
      .map((line) => {
        const [name, mb] = line.split(',')
        return { name: (name ?? '').trim(), vramMb: parseInt((mb ?? '').trim(), 10) || 0, vendor: 'nvidia' as const }
      })
      .filter((g) => g.vramMb > 0)
    if (gpus.length) {
      // Debug aid: dual-GPU users have reported a lower-than-expected total. Log
      // the raw per-GPU VRAM parsed from nvidia-smi so a future report can tell
      // "only one card enumerated" apart from "sum bug" (fixed in hardware.ts).
      console.log(`[sysinfo] nvidia-smi enumerated ${gpus.length} GPU(s): ${gpus.map((g) => `${g.name}=${g.vramMb}MB`).join(', ')}`)
      return gpus
    }
  } catch {
    /* no nvidia-smi */
  }

  // 2) Apple Silicon: treat 65% of unified memory as the VRAM budget (spec 05 §6).
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('system_profiler', ['SPDisplaysDataType'], { timeout: 8000 }).toString()
      const m = out.match(/Chipset Model:\s*(.+)/)
      if (m && /Apple/.test(out)) {
        return [{ name: m[1].trim(), vramMb: Math.round((os.totalmem() / 1e6) * 0.65), vendor: 'apple' }]
      }
    } catch {
      /* ignore */
    }
  }

  // 3) AMD / Intel (and NVIDIA without nvidia-smi): enumerate adapters by name.
  //    VRAM is best-effort here; vendor is what backend selection needs.
  try {
    const gpus = process.platform === 'win32' ? enumWindowsGpus() : enumLinuxGpus()
    if (gpus.length) return gpus
  } catch {
    /* ignore */
  }

  return [] // CPU-only mode
}

function enumWindowsGpus(): GpuInfo[] {
  // AMD first: ROCm's rocm-smi reports true VRAM, unlike WMI's 4GB-capped
  // AdapterRAM below. Only present when ROCm is installed; falls through if not.
  try {
    const amd = rocmSmiGpus()
    if (amd.length) return amd
  } catch {
    /* no rocm-smi (ROCm not installed) — fall back to WMI */
  }

  // Win32_VideoController: Name + AdapterRAM (AdapterRAM caps at 4GB for larger
  // cards and is unreliable — used only as a weak hint). This mis-sizes AMD cards
  // >4GB (e.g. RX 7900 XTX reports ~4GB, not 24GB), which is why AMD is tried via
  // rocm-smi first above.
  const ps =
    'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }'
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    timeout: 8000,
    windowsHide: true,
  }).toString()
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [name, ram] = line.split('|')
      const nm = (name ?? '').trim()
      const bytes = parseInt((ram ?? '').trim(), 10) || 0
      return { name: nm, vramMb: bytes > 0 ? Math.round(bytes / 1e6) : 0, vendor: classifyVendor(nm) }
    })
    .filter((g) => g.name && g.vendor !== 'unknown')
}

// AMD VRAM on Windows via ROCm's rocm-smi. `--showmeminfo vram --json` returns an
// object keyed by "card0", "card1", … each with "VRAM Total Memory (B)". Card
// names aren't in that call, so pair it with --showproductname; degrade to a
// generic "AMD Radeon GPU" name (vendor still classifies as amd) when a name is
// missing. Throws when rocm-smi isn't on PATH so the caller falls back to WMI.
function rocmSmiGpus(): GpuInfo[] {
  const memJson = execFileSync('rocm-smi', ['--showmeminfo', 'vram', '--json'], {
    timeout: 8000,
    windowsHide: true,
  }).toString()

  let nameJson = ''
  try {
    nameJson = execFileSync('rocm-smi', ['--showproductname', '--json'], {
      timeout: 8000,
      windowsHide: true,
    }).toString()
  } catch {
    /* names optional — vendor classification and VRAM come from the mem query */
  }
  return parseRocmSmi(memJson, nameJson)
}

/** Pure parser for rocm-smi --json output, split out for direct testing.
 *  `memJson` is `--showmeminfo vram --json`; `nameJson` (may be empty) is
 *  `--showproductname --json`. */
export function parseRocmSmi(memJson: string, nameJson = ''): GpuInfo[] {
  const mem = JSON.parse(memJson) as Record<string, Record<string, string>>
  let names: Record<string, Record<string, string>> = {}
  if (nameJson.trim()) names = JSON.parse(nameJson) as Record<string, Record<string, string>>

  const gpus: GpuInfo[] = []
  for (const [card, fields] of Object.entries(mem)) {
    const totalKey = Object.keys(fields).find((k) => /VRAM Total Memory/i.test(k))
    const bytes = totalKey ? parseInt(String(fields[totalKey]).trim(), 10) || 0 : 0
    if (bytes <= 0) continue
    const nameFields = names[card] ?? {}
    const nameKey = Object.keys(nameFields).find((k) => /(Card Series|Card Model|Product Name|Device Name)/i.test(k))
    const name = (nameKey ? String(nameFields[nameKey]).trim() : '') || 'AMD Radeon GPU'
    gpus.push({ name, vramMb: Math.round(bytes / 1e6), vendor: 'amd' })
  }
  return gpus
}

function enumLinuxGpus(): GpuInfo[] {
  // lspci gives vendor + name but no VRAM size; read VRAM per-adapter from
  // sysfs (linuxVramMb), matched by the adapter's PCI slot.
  const out = execFileSync('sh', ['-c', "lspci -mm 2>/dev/null | grep -iE 'VGA|3D|Display'"], {
    timeout: 8000,
  }).toString()
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const vendor = classifyVendor(line)
      const slot = line.trim().split(/\s+/)[0] ?? ''
      return { name: line.replace(/"/g, '').trim().slice(0, 80), vramMb: linuxVramMb(slot), vendor }
    })
    .filter((g) => g.vendor !== 'unknown')
}

// amdgpu exposes total VRAM in bytes via sysfs (incl. the BIOS carveout on
// APUs like Ryzen AI / Strix Halo); lspci carries no size. Each lspci -mm line
// begins with the PCI slot (e.g. "c3:00.0"), whose sysfs node lives at
// /sys/bus/pci/devices/<domain>:<slot> — lspci omits the "0000:" domain by
// default, so try both forms. Intel iGPUs / nouveau lack the attribute → 0 (no
// dedicated VRAM), preserving prior behaviour. Byte→MB uses the same /1e6 as
// the nvidia/windows/apple branches.
function linuxVramMb(pciSlot: string): number {
  if (!pciSlot) return 0
  for (const dev of [`/sys/bus/pci/devices/0000:${pciSlot}`, `/sys/bus/pci/devices/${pciSlot}`]) {
    try {
      const bytes = parseInt(fs.readFileSync(`${dev}/mem_info_vram_total`, 'utf8').trim(), 10)
      if (Number.isFinite(bytes) && bytes > 0) return Math.round(bytes / 1e6)
    } catch {
      /* no such device, or adapter exposes no VRAM (Intel iGPU, nouveau) */
    }
  }
  return 0
}
