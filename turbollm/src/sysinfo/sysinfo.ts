// System info detection (spec 05 §6): GPU(s), CPU, RAM. Cached for the process
// lifetime. Used for VRAM-fit estimation, the settings UI, and engine-backend
// selection (ADR-025: vendor → fastest backend).
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'arm' | 'qualcomm' | 'unknown'

export interface GpuInfo {
  name: string
  vramMb: number
  vendor: GpuVendor
  /** True when `vramMb` is a slice of system RAM rather than dedicated VRAM — an APU's
   *  carveout+GTT budget, Apple's unified memory, or an iGPU's shared-memory estimate. Such a
   *  budget must never be *summed* with a discrete card's real VRAM (`detectHardware`), because
   *  they are not two pools: the iGPU's share is the same RAM the box already has. ADR-306. */
  unified?: boolean
}
export interface SysInfo {
  os: string
  cpu: string
  cores: number
  ramMB: number
  gpus: GpuInfo[]
  /** True inside the packaged Android app, where the engines that exist are the ones shipped in
   *  the APK and nothing else can ever be added. `os` alone can't express this: Termux also
   *  reports `android`, and there downloading or building an engine works normally.
   *
   *  The difference is Android's W^X hardening (API 29+): an app may not `execve()` a file it
   *  wrote into its own storage, and only the installed APK's `nativeLibraryDir` is exempt. So a
   *  downloaded engine binary on the app side is not "slow" or "unsupported", it is
   *  unrunnable — proven on-device, where the same binary that failed from app storage ran fine
   *  under `run-as`. Offering install / build-from-source / add-your-own there advertises paths
   *  that cannot work, which is what this flag lets the UI stop doing.
   *
   *  Optional purely so the many `SysInfo` fixtures across the test suite don't each have to
   *  restate a field none of them care about; `getSysInfo()` itself always populates it. */
  bundledEnginesOnly?: boolean
}

let cached: SysInfo | null = null

export function getSysInfo(): SysInfo {
  if (cached) return cached
  cached = {
    os: `${process.platform}/${process.arch}`,
    cpu: getCpuModel(),
    cores: getCpuCoreCount(),
    ramMB: Math.round(os.totalmem() / 1e6),
    gpus: detectGpus(),
    // The app hands us its nativeLibraryDir (MainActivity.kt) because that is the only directory
    // it can execute from; Termux never sets it. So its presence is exactly "am I the packaged
    // app", with no extra flag to keep in sync — and it is already load-bearing for registering
    // the bundled engine (engines/seed.ts).
    bundledEnginesOnly: process.platform === 'android' && !!process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR,
  }
  return cached
}

/** The vendor that drives backend selection: first discrete GPU, else unknown. */
export function primaryVendor(info: SysInfo = getSysInfo()): GpuVendor {
  // Prefer a discrete accelerator over an integrated one (Intel iGPU alongside
  // an NVIDIA/AMD dGPU is common): rank nvidia/amd/apple above intel.
  // Rank arm/qualcomm (mobile iGPUs) same as intel for Vulkan backend selection.
  const rank: Record<GpuVendor, number> = { nvidia: 4, amd: 3, apple: 3, intel: 2, arm: 2, qualcomm: 2, unknown: 1 }
  let best: GpuVendor = 'unknown'
  for (const g of info.gpus) if (rank[g.vendor] > rank[best]) best = g.vendor
  return best
}

/** True when every detected AMD adapter is integrated (an APU iGPU, `unified: true`) —
 *  i.e. there's no discrete AMD card to fall back on. Used by backend selection (GitHub
 *  #103) to avoid defaulting an AMD APU box to ROCm, which doesn't support most integrated
 *  Radeon graphics. False when there's no AMD adapter at all, or at least one is discrete. */
export function amdApuOnly(info: SysInfo = getSysInfo()): boolean {
  const amd = info.gpus.filter((g) => g.vendor === 'amd')
  return amd.length > 0 && amd.every((g) => g.unified)
}

/** True when EVERY detected GPU shares system RAM (`unified: true`) and there is at least one —
 *  an AMD/Intel APU box, an Apple Silicon Mac, an ARM/Qualcomm mobile SoC. Vendor-agnostic on
 *  purpose: what matters downstream is the memory topology, not who made the part.
 *
 *  Used by auto-tune's spill detection (GitHub #179, and the unified-ness `hardware.ts` computes
 *  for #164): on a UMA part there is no VRAM/RAM boundary for weights to be demoted ACROSS, so
 *  host-backed GPU memory is the normal state rather than evidence of a spill. See `spill.ts`.
 *
 *  The `length > 0` guard is load-bearing — `[].every()` is `true`, so without it a CPU-only box
 *  (no GPUs at all) would report as unified. False also whenever ANY discrete card is present:
 *  that card has its own VRAM and can genuinely spill out of it. */
export function unifiedMemoryOnly(info: SysInfo = getSysInfo()): boolean {
  return info.gpus.length > 0 && info.gpus.every((g) => g.unified === true)
}

export function classifyVendor(name: string): GpuVendor {
  const n = name.toLowerCase()
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(n)) return 'nvidia'
  if (/amd|radeon|\brx\b|instinct|vega|firepro/.test(n)) return 'amd'
  if (/intel|arc|iris|\buhd\b|\bhd graphics\b/.test(n)) return 'intel'
  if (/apple/.test(n)) return 'apple'
  if (/mali|immortalis/.test(n)) return 'arm'
  if (/adreno/.test(n)) return 'qualcomm'
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
  // AMD's *numbered* APU iGPU branding, which carries no "Graphics" suffix and so misses the
  // rule above: "Radeon 780M"/"Radeon 890M" (Phoenix→Strix Point) and "Radeon 8050S/8060S"
  // (Strix Halo). Deliberately narrow, because the failure direction here is the dangerous one
  // (an over-reported budget green-lights a load that then OOMs):
  //   - only 3-digit numbers from 600 up, and 4-digit ones — AMD's low-end DISCRETE mobile line
  //     stopped at "Radeon 520M/530M/540M/550M", so 5xx and below must stay excluded;
  //   - older discrete mobile parts always carry a series prefix ("Radeon HD 6770M",
  //     "Radeon R7 M340"), which breaks the `radeon`-then-digits adjacency this needs;
  //   - the RX/PRO/Instinct/Vega-N exclusion above still applies ("Radeon RX 7600M XT",
  //     "Radeon Pro 5600M" are discrete).
  // On Linux this is only the FALLBACK — the authoritative APU check is KFD topology
  // (see linuxAmdIsApu); it matters on boxes where amdkfd isn't loaded. ADR-304 / GitHub #85.
  if (/radeon\s*(?:[6-9]\d{2}|\d{4})\s*[ms]\b/.test(n) && !/\b(rx|pro|instinct|vega\s*\d|firepro)\b/.test(n)) return true
  // Newest Intel Core Ultra generic branding — plain "Intel(R) Graphics" with no
  // qualifier at all (confirmed on a real Core Ultra 7 265K / Arrow Lake-S box).
  // Intel's only current discrete lineup is Arc-branded, so any other Intel name
  // containing "graphics" with no Arc qualifier is integrated.
  if (/intel/.test(n) && /graphics/.test(n) && !/\barc\b/.test(n)) return true
  // ARM Mali / Qualcomm Adreno mobile GPUs always share system RAM.
  if (/mali|immortalis/.test(n)) return true
  if (/adreno/.test(n)) return true
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
        return [{ name: m[1].trim(), vramMb: Math.round((os.totalmem() / 1e6) * 0.65), vendor: 'apple', unified: true }]
      }
    } catch {
      /* ignore */
    }
  }

  // 3) AMD / Intel / ARM / Qualcomm (and NVIDIA without nvidia-smi): enumerate adapters by name.
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
      const integrated = isIntegratedGpuName(nm)
      const vramMb = integrated
        ? Math.round((os.totalmem() / 1e6) * 0.5)
        : bytes > 0 ? Math.round(bytes / 1e6) : 0
      // `unified`: a shared-memory estimate must not be pooled with a discrete card of the same
      // vendor (an Intel iGPU next to an Intel Arc dGPU is the live case here). ADR-306.
      return { name: nm, vramMb, vendor: classifyVendor(nm), ...(integrated ? { unified: true } : {}) }
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
      "Where-Object { $_.PSChildName -match '^\\d{4}$' } | " +
      "ForEach-Object { " +
      "try { " +
      "$p = Get-ItemProperty -Path $_.PSPath -ErrorAction Stop; " +
      "if ($p.'HardwareInformation.qwMemorySize') { " +
      "\"$($p.DriverDesc)|$($p.'HardwareInformation.qwMemorySize')\" " +
      "} " +
      "} catch { } " +
      "}; exit 0"

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
    // `unified` must be set HERE too, not only on the WMI/lspci paths (GitHub #179): rocm-smi is
    // tried FIRST on AMD boxes, so on any APU where ROCm happens to resolve, this parser is the one
    // that produces the GpuInfo — and without the flag that machine silently loses its unified-ness
    // for every consumer of it (`amdApuOnly` backend selection, `unifiedMemoryOnly` spill gating).
    // The generic fallback name ("AMD Radeon GPU") is deliberately NOT integrated by this test, so
    // an unnamed discrete card keeps today's classification.
    const integrated = isIntegratedGpuName(name)
    gpus.push({ name, vramMb: Math.round(bytes / 1e6), vendor: 'amd', ...(integrated ? { unified: true } : {}) })
  }
  return gpus
}

function enumLinuxGpus(): GpuInfo[] {
  // 1) Desktop Linux path (lspci)
  // lspci gives vendor + name but no VRAM size; read VRAM per-adapter from
  // sysfs (linuxVramMb), matched by the adapter's PCI slot.
  try {
    const out = execFileSync('sh', ['-c', "lspci -mm 2>/dev/null | grep -iE 'VGA|3D|Display'"], {
      timeout: 8000,
    }).toString()
    
    if (out.trim()) {
      const gpus = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => linuxGpuFromLspci(line, linuxAmdgpuMem, linuxAmdIsApu, os.totalmem(), console.log))
        .filter((g): g is GpuInfo => g !== null && g.vendor !== 'unknown')

      if (gpus.length) return gpus
    }
  } catch {
    /* lspci not available (Android) — fall through to vulkaninfo */
  }

  // 2) Android / Termux path (vulkaninfo)
  // lspci doesn't exist on Android. We fall back to vulkaninfo, which queries
  // the Vulkan loader directly. This correctly identifies Mali/Adreno GPUs.
  return enumVulkanGpus()
}

/** Parse `vulkaninfo --summary` for GPU name and type. Works on Termux + Android. */
function enumVulkanGpus(): GpuInfo[] {
  try {
    // The Android system loader + liblzma preload work around the Xzs_Construct
    // dlopen bug in vulkaninfo on Android 15/16. This is Android-specific —
    // /system/lib64/liblzma.so doesn't exist on a normal Linux box — so gate
    // the env override on `process.platform === 'android'` and run plain
    // vulkaninfo everywhere else. (We only land here on Linux when lspci is
    // missing, e.g. inside some containers, not just Android — keep that path
    // clean.)
    const isAndroid = process.platform === 'android'
    const env = isAndroid
      ? {
          ...process.env,
          LD_LIBRARY_PATH: `/system/lib64:${process.env.LD_LIBRARY_PATH ?? ''}`,
          LD_PRELOAD: '/system/lib64/liblzma.so',
        }
      : process.env
    const out = execFileSync('vulkaninfo', ['--summary'], { timeout: 8000, env }).toString()
    const gpus: GpuInfo[] = []
    const lines = out.split('\n')
    let inDevice = false
    let deviceName = ''
    let deviceType = ''
    for (const line of lines) {
      if (/^GPU\d+:/.test(line.trim())) {
        if (deviceName) gpus.push(makeVulkanGpu(deviceName, deviceType))
        inDevice = true
        deviceName = ''
        deviceType = ''
        continue
      }
      if (inDevice) {
        const m1 = line.match(/deviceName\s*=\s*(.+)/i)
        if (m1) deviceName = m1[1].trim()
        const m2 = line.match(/deviceType\s*=\s*(.+)/i)
        if (m2) deviceType = m2[1].trim()
      }
    }
    if (deviceName) gpus.push(makeVulkanGpu(deviceName, deviceType))
    return gpus
  } catch {
    return []
  }
}

function makeVulkanGpu(name: string, deviceType: string): GpuInfo {
  const vendor = classifyVendor(name)
  const integrated = /INTEGRATED_GPU/i.test(deviceType) || isIntegratedGpuName(name)
  // Mali/Adreno share system RAM; estimate 50% (matches the Windows iGPU heuristic).
  // Lower this to 0.3–0.4 if the tool then tries to load a model that's too large.
  const vramMb = integrated
    ? Math.round((os.totalmem() / 1e6) * 0.5)
    : 0
  return { name, vramMb, vendor, ...(integrated ? { unified: true } : {}) }
}

/** One `lspci -mm` line, split into fields. Format:
 *  `slot "class" "vendor" "device" [-rNN] [-pNN] "svendor" "sdevice"`. */
export interface LspciEntry {
  slot: string
  deviceClass: string
  vendor: string
  device: string
}

/** Pure parser for a single `lspci -mm` line, split out for direct testing. Null when the line
 *  doesn't have the expected shape (caller then keeps the old whole-line behaviour). */
export function parseLspciMm(line: string): LspciEntry | null {
  const slot = line.trim().split(/\s+/)[0] ?? ''
  const fields = (line.match(/"[^"]*"/g) ?? []).map((f) => f.slice(1, -1).trim())
  if (!slot || slot.includes('"') || fields.length < 3) return null
  return { slot, deviceClass: fields[0], vendor: fields[1], device: fields[2] }
}

/** The whole per-adapter decision for one `lspci -mm` line — display name, vendor, and usable
 *  VRAM budget — split out for direct testing behind two injected seams (`readMem` reads sysfs,
 *  `isApu` reads KFD topology; production passes {@link linuxAmdgpuMem} / `linuxAmdIsApu`).
 *  Returns null for a line that isn't a parseable adapter at all. */
export function linuxGpuFromLspci(
  line: string,
  readMem: (pciSlot: string) => AmdgpuMem,
  isApu: (pciSlot: string, label: string) => boolean,
  totalRamBytes: number,
  log: (msg: string) => void = () => {},
): GpuInfo | null {
  const entry = parseLspciMm(line)
  const slot = entry?.slot ?? (line.trim().split(/\s+/)[0] ?? '')
  if (!slot) return null
  // Classify against vendor + device, never the device alone: "graphics" often lives in the
  // device field while "intel" only appears in the vendor field (e.g. vendor "Intel Corporation"
  // + device "3rd Gen Core processor Graphics Controller"), so splitting them would silently
  // un-detect those iGPUs.
  const label = entry ? `${entry.vendor} ${entry.device}` : line
  // Display name: the device field alone. The whole raw lspci line used to be the name, which
  // read as a PCI dump in Settings → Hardware ("c6:00.0 Display controller Advanced Micro
  // Devices, Inc. [AMD/ATI] Strix Halo [Ra…" — GitHub #85's screenshot). GPU names are
  // display/log-only (nothing branches on them), so this is safe. ADR-304.
  // A device newer than the local pci.ids has no name there, and lspci prints a bare
  // "Device 7550" — useless on its own, so keep the vendor in front of it (ADR-306).
  const device = entry ? (/^device\s+[0-9a-f]{4}$/i.test(entry.device) ? `${entry.vendor} ${entry.device}` : entry.device) : ''
  const name = entry ? device.slice(0, 80) : line.replace(/"/g, '').trim().slice(0, 80)
  const vendor = classifyVendor(label)
  const mem = readMem(slot)
  // sysfs's mem_info_vram_total only exists for amdgpu-driven cards (dedicated
  // VRAM, or an APU's BIOS carveout) — Intel iGPUs / nouveau read 0 here, which
  // means "no dedicated VRAM", not "no usable memory". Reporting that literal 0
  // was making quant auto-selection always pick the smallest file and the fit
  // check always show red, on hardware where the real constraint is different.
  let vramMb = mem.vramMb
  let unified = false
  if (mem.vramMb > 0 && vendor === 'amd' && mem.gttMb > 0 && isApu(slot, label)) {
    // Unified-memory APU: the BIOS carveout alone is NOT the budget (GitHub #85).
    vramMb = amdApuVramMb(mem.vramMb, mem.gttMb, totalRamBytes)
    unified = true
    log(`[sysinfo] amdgpu APU at ${slot}: vram=${mem.vramMb}MB + gtt=${mem.gttMb}MB → ${vramMb}MB usable`)
  } else if (vramMb === 0 && isIntegratedGpuName(label)) {
    vramMb = Math.round((totalRamBytes / 1e6) * 0.5)
    unified = true
  }
  return { name, vramMb, vendor, ...(unified ? { unified: true } : {}) }
}

/** amdgpu's two memory pools for one adapter, in MB (0 = attribute absent/unreadable).
 *  `vramMb` is dedicated VRAM — on an APU, just the small BIOS carveout. `gttMb` is the GTT
 *  pool: how much system RAM the driver will let the GPU map. */
export interface AmdgpuMem {
  vramMb: number
  gttMb: number
}

// amdgpu exposes both pool totals in bytes via sysfs (incl. the BIOS carveout on
// APUs like Ryzen AI / Strix Halo); lspci carries no size. Each lspci -mm line
// begins with the PCI slot (e.g. "c3:00.0"), whose sysfs node lives at
// /sys/bus/pci/devices/<domain>:<slot> — lspci omits the "0000:" domain by
// default, so try both forms. Intel iGPUs / nouveau lack the attributes → 0 (no
// dedicated VRAM), preserving prior behaviour. Byte→MB uses the same /1e6 as
// the nvidia/windows/apple branches. Both reads come from the SAME device dir.
function linuxAmdgpuMem(pciSlot: string): AmdgpuMem {
  if (!pciSlot) return { vramMb: 0, gttMb: 0 }
  for (const dev of [`/sys/bus/pci/devices/0000:${pciSlot}`, `/sys/bus/pci/devices/${pciSlot}`]) {
    const vram = readSysfsBytes(dev, 'mem_info_vram_total')
    if (vram > 0) return { vramMb: Math.round(vram / 1e6), gttMb: Math.round(readSysfsBytes(dev, 'mem_info_gtt_total') / 1e6) }
  }
  return { vramMb: 0, gttMb: 0 }
}

function readSysfsBytes(dir: string, attr: string): number {
  try {
    const bytes = parseInt(fs.readFileSync(`${dir}/${attr}`, 'utf8').trim(), 10)
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  } catch {
    /* no such device, or the adapter doesn't expose this attribute */
    return 0
  }
}

/** The offload budget for a unified-memory AMD APU: the BIOS VRAM carveout PLUS the GTT pool.
 *  On an APU both are the same physical RAM at the same bandwidth, so GTT is genuinely usable
 *  for offload — which is why this must never be applied to a discrete card, where GTT is system
 *  RAM reached across PCIe. GitHub #85: a Strix Halo box (131 GB RAM, 1 GiB carveout, 108 GiB
 *  GTT) was reported as a 1.1 GB-VRAM GPU, so every model showed "will spill to system RAM" and
 *  auto-tune had nothing that fit. The 90%-of-RAM cap is only a nonsense guard for a hand-set
 *  `amdgpu.gttsize=`; the driver's own GTT limit is already a fraction of RAM, so it rarely binds.
 *  ADR-304. */
export function amdApuVramMb(vramMb: number, gttMb: number, totalRamBytes: number): number {
  const cap = Math.round((totalRamBytes / 1e6) * 0.9)
  return Math.max(vramMb, Math.min(vramMb + gttMb, cap))
}

/** One KFD topology node that has SIMDs (i.e. a GPU), and whether it is a *fused* node — one
 *  the kernel attached to a CPU node, which only ever happens for an APU. */
export interface KfdGpuNode {
  domain: number
  locationId: number
  fused: boolean
}

/** Pure parser for `/sys/class/kfd/kfd/topology/nodes/N/properties` bodies, split out for direct
 *  testing. Nodes with no SIMDs are plain CPU nodes and are skipped.
 *
 *  `fused` (SIMDs **and** CPU cores on one node) proves an APU but does **not** disprove one —
 *  see {@link linuxAmdIsApu}. ADR-306 corrects ADR-304 here: `kfd_assign_gpu()` skips every
 *  device with `cpu_cores_count` when placing a GPU (*"Discrete GPUs need their own topology
 *  device list entries. Don't assign them to CPU/APU nodes."*), unconditionally since IOMMUv2 was
 *  removed in 6.6. So on any current kernel even an APU's iGPU gets its own node reporting
 *  `cpu_cores_count 0`, and only the old IOMMUv2 parts (Kaveri/Carrizo/Raven) ever fuse. */
export function parseKfdNodes(propsTexts: string[]): KfdGpuNode[] {
  const nodes: KfdGpuNode[] = []
  for (const text of propsTexts) {
    const prop = (key: string): number => {
      const m = new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(text)
      return m ? parseInt(m[1], 10) : 0
    }
    if (prop('simd_count') <= 0) continue // CPU-only node
    nodes.push({ domain: prop('domain'), locationId: prop('location_id'), fused: prop('cpu_cores_count') > 0 })
  }
  return nodes
}

/** A PCI slot split into the two halves KFD keys a node by: the domain (PCI segment) and
 *  `pci_dev_id()` = `(bus << 8) | (device << 3) | function`. Null when the slot isn't in lspci's
 *  `[domain:]bus:device.function` form. Both halves matter: `location_id` alone is identical for
 *  `0000:c6:00.0` and `0001:c6:00.0`, so a multi-segment box could match a discrete card against
 *  an APU's node (ADR-306). */
export function pciSlotToKfdIds(slot: string): { domain: number; locationId: number } | null {
  const m = /^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i.exec(slot.trim())
  if (!m) return null
  return {
    domain: m[1] === undefined ? 0 : parseInt(m[1], 16),
    locationId: (parseInt(m[2], 16) << 8) | ((parseInt(m[3], 16) & 0x1f) << 3) | parseInt(m[4], 10),
  }
}

/** Is this amdgpu adapter a unified-memory APU (so GTT counts toward the offload budget)?
 *
 *  **KFD may only ever answer YES, never NO** (ADR-306). A fused node proves an APU; the absence
 *  of one proves nothing, because current kernels give every GPU its own node (see
 *  {@link parseKfdNodes}). ADR-304 shipped this as `if (match) return match.apu`, which made
 *  KFD's negative authoritative and vetoed the name heuristic — on the reporter's own Strix Halo
 *  that turned the whole fix into a no-op. The name heuristic decides everything KFD can't, which
 *  in practice is every APU newer than Raven. */
function linuxAmdIsApu(pciSlot: string, label: string): boolean {
  if (kfdReportsFusedNode(pciSlot)) return true
  return isIntegratedGpuName(label)
}

/** True only when KFD positively identifies THIS adapter as a fused (APU) node, matched on both
 *  PCI domain and location_id. Any other outcome — no amdkfd, no matching node, a non-fused node
 *  — is "don't know", not "no". */
function kfdReportsFusedNode(pciSlot: string): boolean {
  const ids = pciSlotToKfdIds(pciSlot)
  if (!ids) return false
  return readKfdNodes().some((n) => n.domain === ids.domain && n.locationId === ids.locationId && n.fused)
}

function readKfdNodes(): KfdGpuNode[] {
  const base = '/sys/class/kfd/kfd/topology/nodes'
  try {
    const texts: string[] = []
    for (const entry of fs.readdirSync(base)) {
      try {
        texts.push(fs.readFileSync(`${base}/${entry}/properties`, 'utf8'))
      } catch {
        /* node disappeared between readdir and read */
      }
    }
    return parseKfdNodes(texts)
  } catch {
    return [] // amdkfd not loaded (no ROCm-capable kernel module) — caller falls back
  }
}

/** Android/Termux fallback for CPU model, as os.cpus() is often restricted or empty. */
function getCpuModel(): string {
  const model = os.cpus()[0]?.model?.trim()
  if (model && model.length > 0) return model
  // Android /proc/cpuinfo usually has a "Hardware" or "model name" line.
  // Note: Node reports `process.platform === 'android'` on Termux/Android — distinct
  // from 'linux' (see NodeJS.Platform type) — so we must include it here, otherwise
  // the exact Android case this fallback exists for would silently never trigger.
  if (process.platform === 'linux' || process.platform === 'android') {
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8')
      const m =
        cpuinfo.match(/Hardware\s*:\s*(.+)/) ||
        cpuinfo.match(/model name\s*:\s*(.+)/)
      if (m) return m[1].trim()
    } catch {
      /* ignore */
    }
  }
  return model ?? ''
}

/** Android/Termux fallback for CPU core count, as os.cpus() often reports 1 due to cgroups. */
function getCpuCoreCount(): number {
  const cpus = os.cpus()
  if (cpus.length > 1) return cpus.length
  // Fallback 1: nproc (available in Termux)
  try {
    const n = parseInt(execFileSync('nproc', { timeout: 2000 }).toString().trim(), 10)
    if (n > 0) return n
  } catch {
    /* nproc missing */
  }
  // Fallback 2: count "processor" lines in /proc/cpuinfo.
  // Same Android note as getCpuModel(): must include 'android' explicitly,
  // otherwise the fallback silently skips on the platform it's meant to fix.
  if (process.platform === 'linux' || process.platform === 'android') {
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8')
      const matches = cpuinfo.match(/processor\s*:/g)
      if (matches && matches.length > 0) return matches.length
    } catch {
      /* ignore */
    }
  }
  return cpus.length || 1
}
