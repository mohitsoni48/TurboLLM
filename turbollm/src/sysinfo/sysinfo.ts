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

/** True for GPU names that are almost certainly an integrated GPU sharing system RAM
 *  rather than having independent dedicated VRAM. Used to correct dedicated-VRAM
 *  readings that are actively wrong for iGPUs (WMI's AdapterRAM on Windows, the missing
 *  sysfs attribute on Linux — see enumWindowsGpus/linuxVramMb below) without
 *  misclassifying a discrete card that happens to share a vendor (e.g. Intel Arc dGPUs,
 *  which do report real dedicated VRAM). Name-pattern heuristic, not yet live-verified
 *  against real iGPU hardware — see docs/TODO.md Release 4. */
export function isIntegratedGpuName(name: string): boolean {
  const n = name.toLowerCase()
  // Classic Intel integrated branding — never used for a discrete card.
  if (/iris|uhd graphics|hd graphics/.test(n)) return true
  // Intel's newer "Arc Graphics" iGPU branding (Meteor Lake/Lunar Lake+) carries no
  // model number; every discrete Arc card does — consumer 3-digit (A380/A750/A770/
  // B570/B580) AND the 2-digit "Arc Pro" workstation line (A40/A50/A60, B50/B60).
  // Pre-release review caught the original 3-digit-only pattern misclassifying Arc
  // Pro cards as integrated, over-reporting their VRAM (dangerous direction — could
  // green-light a load that then OOMs); \d{2,4} plus an optional "pro" also covers
  // any future model-number length without narrowing further.
  if (/\barc\b/.test(n) && !/\b(?:pro\s+)?[ab]\d{2,4}\b/.test(n)) return true
  // AMD APU iGPU branding ("Radeon(TM) Graphics", generic) vs. a discrete card, which
  // always carries an RX/PRO/Instinct/Vega-N model name.
  if (/radeon.*graphics/.test(n) && !/\b(rx|pro|instinct|vega\s*\d|firepro)\b/.test(n)) return true
  // Newest Intel Core Ultra generic branding — plain "Intel(R) Graphics" with no
  // qualifier at all (confirmed on a real Core Ultra 7 265K / Arrow Lake-S box).
  // Intel's only current discrete lineup is Arc-branded, so any other Intel name
  // containing "graphics" with no Arc qualifier is integrated.
  if (/intel/.test(n) && /graphics/.test(n) && !/\barc\b/.test(n)) return true
  return false
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
  // AdapterRAM below. Only present when ROCm is installed; falls through if not —
  // which is the COMMON case for consumer Radeon cards (ROCm's Windows support is
  // limited and doesn't cover most gaming GPUs, e.g. the RX 9000 series), so most
  // AMD users still hit the WMI path below.
  try {
    const amd = rocmSmiGpus()
    if (amd.length) return amd
  } catch {
    /* no rocm-smi (ROCm not installed, or unsupported on this card) — fall back to WMI */
  }

  // Win32_VideoController: Name + AdapterRAM (AdapterRAM caps at 4GB for larger
  // cards and is unreliable — used only as a weak hint). This mis-sizes AMD cards
  // >4GB (e.g. RX 7900 XTX / RX 9070 XT report ~4GB, not their real 16-24GB —
  // GitHub #63), which is why AMD is tried via rocm-smi first above, and why the
  // registry is cross-checked below for whatever falls through to here.
  const ps =
    'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }'
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    timeout: 8000,
    windowsHide: true,
  }).toString()
  const wmiGpus = out
    .trim()
    .split('\n')
    .map((line) => {
      const [name, ram] = line.split('|')
      const nm = (name ?? '').trim()
      const bytes = parseInt((ram ?? '').trim(), 10) || 0
      // AdapterRAM is a weak hint at best (see comment above) and is actively wrong
      // for integrated GPUs — it reports a tiny fixed aperture (or 0), not the real
      // chunk of system RAM the OS lets an iGPU use, which was making quant
      // auto-selection always pick the smallest file and the fit check always show
      // red. Apply the same shared-memory heuristic used for Apple Silicon below,
      // scaled down (50% vs. 65%) to match Windows' more conservative default
      // "shared GPU memory" cap.
      const vramMb = isIntegratedGpuName(nm)
        ? Math.round((os.totalmem() / 1e6) * 0.5)
        : bytes > 0 ? Math.round(bytes / 1e6) : 0
      return { name: nm, vramMb, vendor: classifyVendor(nm) }
    })
    .filter((g) => g.name && g.vendor !== 'unknown')

  // AdapterRAM is a 32-bit DWORD — it silently caps/wraps for ANY card past ~4 GB, not just
  // AMD (the exact "4.3 GB" GitHub #63 reported for a real 16 GB card). The registry keeps the
  // SAME total as a proper 64-bit value under each display adapter's driver key — this is how
  // GPU-Z/HWiNFO get it right too — so read it and prefer it over AdapterRAM whenever it's
  // bigger, for every discrete card. rocm-smi above already covers the ROCm-equipped AMD case;
  // this covers everyone who fell through to WMI (most consumer AMD/Intel dGPU owners).
  const registryVram = readWindowsVramRegistry()
  return wmiGpus.map((g) => {
    if (isIntegratedGpuName(g.name)) return g
    const fromRegistry = findRegistryVram(registryVram, g.name)
    return fromRegistry !== undefined && fromRegistry > g.vramMb ? { ...g, vramMb: fromRegistry } : g
  })
}

/** A display adapter's true VRAM as read from the registry, before matching to a WMI entry. */
export interface RegistryVram {
  name: string
  vramMb: number
}

// Display-adapter driver class GUID (stable across all Windows versions) — each installed
// adapter gets a numbered subkey here with its driver-reported HardwareInformation.qwMemorySize.
const DISPLAY_CLASS_GUID = '{4d36e968-e325-11ce-bfc1-08002be10318}'

/** Best-effort read of every display adapter's true VRAM from the Windows registry — a proper
 *  64-bit value, unlike WMI's 32-bit-capped AdapterRAM (see enumWindowsGpus). Empty array on any
 *  failure (missing key, no permission, non-Windows): the caller just keeps the AdapterRAM value. */
function readWindowsVramRegistry(): RegistryVram[] {
  try {
    const ps =
      `Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\${DISPLAY_CLASS_GUID}' -ErrorAction SilentlyContinue | ` +
      "ForEach-Object { $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue; " +
      "if ($p.'HardwareInformation.qwMemorySize') { \"$($p.DriverDesc)|$($p.'HardwareInformation.qwMemorySize')\" } }"
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 8000,
      windowsHide: true,
    }).toString()
    return parseWindowsVramRegistry(out)
  } catch {
    return []
  }
}

/** Pure parser for {@link readWindowsVramRegistry}'s PowerShell output, split out for direct
 *  testing (mirrors {@link parseRocmSmi}). Each line is "DriverDesc|qwMemorySize(bytes)". */
export function parseWindowsVramRegistry(psOutput: string): RegistryVram[] {
  const out: RegistryVram[] = []
  for (const line of psOutput.trim().split('\n')) {
    const [name, bytes] = line.split('|')
    const nm = (name ?? '').trim()
    const b = parseInt((bytes ?? '').trim(), 10)
    if (nm && Number.isFinite(b) && b > 0) out.push({ name: nm, vramMb: Math.round(b / 1e6) })
  }
  return out
}

/** Loose GPU-name match between WMI's Name and the registry's DriverDesc — normally identical,
 *  but can differ in trademark symbols/punctuation/whitespace/case, so compare a normalized form. */
function findRegistryVram(entries: RegistryVram[], wmiName: string): number | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
  const target = norm(wmiName)
  return entries.find((e) => norm(e.name) === target)?.vramMb
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
      const name = line.replace(/"/g, '').trim().slice(0, 80)
      const sysfsVramMb = linuxVramMb(slot)
      // sysfs's mem_info_vram_total only exists for amdgpu-driven cards (dedicated
      // VRAM, or an APU's BIOS carveout) — Intel iGPUs / nouveau read 0 here, which
      // means "no dedicated VRAM", not "no usable memory". Reporting that literal 0
      // was making quant auto-selection always pick the smallest file and the fit
      // check always show red, on hardware where the real constraint is different.
      const vramMb = sysfsVramMb > 0
        ? sysfsVramMb
        : isIntegratedGpuName(name)
          ? Math.round((os.totalmem() / 1e6) * 0.5)
          : 0
      return { name, vramMb, vendor }
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
