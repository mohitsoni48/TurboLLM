// Engine probe (spec 03 §3): run <bin> --version and --help to capture the
// version + a capability fingerprint. Ports the verified Go probe.
import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FlagInfo } from '../config/config'

export interface ProbeResult {
  version: string
  capabilities: { kvTypes: string[]; flags: string[]; flagInfo: FlagInfo[] }
}

export class ProbeError extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(msg)
    this.name = 'ProbeError'
  }
}

const RE_VERSION = /^\s*version:\s*(.+?)\s*$/im
const RE_FLAG = /--[a-z0-9][a-z0-9-]+/g
const KNOWN_KV = ['f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_1']

/** execFile error carrying the Node-specific fields we inspect for the timeout
 *  case (`killed` + `signal` are set when the `timeout` option fires). */
type ExecError = Error & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number }

/** True when execFile aborted the process because it exceeded the `timeout`
 *  option — Node sets `killed: true` and `signal` to the kill signal (SIGTERM by
 *  default). Distinguishes a hung binary from one that exits non-zero. */
function isTimeout(err: Error | null): boolean {
  if (!err) return false
  const e = err as ExecError
  return e.killed === true && (e.signal === 'SIGTERM' || e.signal != null)
}

function runCaptured(bin: string, arg: string): Promise<{ out: string; err: Error | null }> {
  return new Promise((resolve) => {
    // execFile normally reports spawn failures via the callback, but on Windows a
    // corrupt / wrong-arch binary can make it throw synchronously — catch that so
    // it folds into a clean `probe_failed` instead of escaping as a 500.
    try {
      // macOS Metal binaries JIT-compile their shader library on first run, which
      // takes 10-30 s depending on the fork's embedded shaders. Use a longer
      // timeout on macOS so this first-run compilation doesn't fail the probe.
      const timeoutMs = process.platform === 'darwin' ? 60_000 : 15_000
      execFile(bin, [arg], { cwd: dirname(bin), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ out: (stdout || '') + (stderr || ''), err: error })
      })
    } catch (e) {
      resolve({ out: '', err: e as Error })
    }
  })
}

export async function probe(bin: string): Promise<ProbeResult> {
  if (!existsSync(bin) || statSync(bin).isDirectory()) {
    throw new ProbeError('binary_not_found', 'Binary not found at that path.')
  }

  // Catch the common mistake — a binary built for a different OS (e.g. a Windows
  // .exe selected on macOS) — and explain it precisely instead of letting the
  // OS refuse to run it and surfacing a vague "could not run" (spec 03 §2
  // `binary_not_executable`). Native-format check via magic bytes; foreign
  // formats only — an unrecognised header (e.g. a shell-script wrapper) is left
  // to the execution probe below rather than blocked here.
  const fmt = detectFormat(bin)
  const expected: BinFormat =
    process.platform === 'win32' ? 'pe' : process.platform === 'darwin' ? 'macho' : 'elf'
  if (fmt !== 'unknown' && fmt !== expected) {
    throw new ProbeError(
      'binary_not_executable',
      `This looks like a ${osLabel(fmt)} binary, but TurboLLM is running on ${osLabel(expected)}. ` +
        `Use the ${osLabel(expected)} build of the engine.`,
    )
  }

  const v = await runCaptured(bin, '--version')
  const h = await runCaptured(bin, '--help')
  if (v.err && h.err) {
    // Both invocations failed because the binary never exited within the probe
    // timeout — surface a distinct `probe_timeout` (spec 03 §2) so the UI can
    // tell a hung/arg-hungry binary apart from one that exited non-zero.
    if (isTimeout(v.err) && isTimeout(h.err)) {
      const timeoutSec = process.platform === 'darwin' ? 60 : 15
      throw new ProbeError('probe_timeout', `The binary did not respond within ${timeoutSec} seconds.`)
    }
    let msg = 'Could not run the binary (--version and --help both failed).'
    const tail = lastLine(v.out)
    if (tail) msg += ' ' + tail
    throw new ProbeError('probe_failed', msg)
  }

  const combined = v.out + '\n' + h.out
  const m = RE_VERSION.exec(combined)
  let version = m ? m[1].trim() : trimLen(firstNonEmptyLine(v.out), 100)
  if (!version) version = 'unknown'

  const flags = extractFlags(h.out)
  const kvTypes = detectKvTypes(h.out, flags.includes('--cache-type-k'))
  const flagInfo = flags.map((f) => classifyFlag(f, h.out))

  // Capture the accepted `--spec-type` enum values (e.g. `none,draft-mtp,nextn`)
  // as `spec-type:<value>` pseudo-flags. The enum differs by engine — official
  // llama.cpp has no `nextn`, the TurboQuant fork does — so speculative-decoding
  // arg emission must check the VALUE is accepted, not just that the flag exists.
  // The enum's printed form differs by engine: official llama.cpp lists it
  // comma-separated (`none,draft-mtp,...`), the TurboQuant fork bracket/pipe
  // (`[none|draft|nextn|...]`). Match only the actual enum (a bracket group, or a
  // multi-value comma/pipe list) — never the prose mentions like `--spec-type mtp,
  // or ...` — and union the values across all such occurrences.
  const ENUM_RE = /--spec-type\s+(\[[^\]\n]+\]|[a-z][a-z0-9_-]*(?:[,|][a-z0-9_-]+)+)/gi
  for (const m2 of h.out.matchAll(ENUM_RE)) {
    for (const v of m2[1].replace(/[[\]]/g, '').split(/[,|]/)) {
      const t = v.trim()
      if (t) flags.push(`spec-type:${t}`)
    }
  }

  return { version, capabilities: { kvTypes, flags: [...new Set(flags)].sort(), flagInfo } }
}

type BinFormat = 'pe' | 'elf' | 'macho' | 'unknown'

/** Identify a native executable by its leading magic bytes. Returns 'unknown'
 *  for anything we can't positively classify (scripts, unreadable files). */
function detectFormat(bin: string): BinFormat {
  let fd: number | undefined
  try {
    fd = openSync(bin, 'r')
    const buf = Buffer.alloc(4)
    const n = readSync(fd, buf, 0, 4, 0)
    if (n >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return 'pe' // "MZ" — Windows PE
    if (n >= 4) {
      if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'elf' // 0x7F ELF
      const be = buf.readUInt32BE(0)
      const le = buf.readUInt32LE(0)
      // Mach-O thin (feedface/feedfacf) + universal/fat (cafebabe/cafebabf).
      const macho = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf])
      if (macho.has(be) || macho.has(le)) return 'macho'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function osLabel(fmt: BinFormat): string {
  return fmt === 'pe' ? 'Windows' : fmt === 'macho' ? 'macOS' : 'Linux'
}

/** Extracts the set of `--flag` tokens a `--help` dump documents as currently
 *  accepted. Matches per-line rather than over the whole blob: llama.cpp keeps
 *  printing removed flags in --help as "--draft-max N   the argument has been
 *  removed. use --spec-draft-n-max or ..." (GitHub #43) — a naive whole-text
 *  regex reads that mention as proof --draft-max is still accepted, so
 *  TurboLLM passes it straight to the engine and it exits immediately on
 *  launch. Skip any line that says a flag was removed; a genuinely-supported
 *  successor flag (e.g. --spec-draft-n-max) still gets captured from its own
 *  dedicated --help entry elsewhere in the output. */
export function extractFlags(helpText: string): string[] {
  const flagSet = new Set<string>()
  for (const line of helpText.split('\n')) {
    if (/\bhas been removed\b/i.test(line)) continue
    for (const f of line.match(RE_FLAG) ?? []) flagSet.add(f)
  }
  return [...flagSet].sort()
}

/** Detect which KV-cache types --cache-type-k actually accepts, from that flag's OWN help
 *  block — not a blind "does 'turbo' appear anywhere in --help" search across the whole output
 *  (a real false-positive bug: an unrelated engine — e.g. ik_llama.cpp — can mention "turbo"
 *  somewhere in its help text with no connection to KV cache types, and used to get turbo2/3/4
 *  added to its capabilities, which either silently degrades in `profileToArgs`'s `kvOk` gate or
 *  can leak an unsupported --cache-type-k value into a launch on an engine that doesn't
 *  understand it). `\s+\S+\b` right after the flag (not `-`) excludes the -draft/-first/-last
 *  sibling flags, whose text is unrelated to the main K-cache type enum. Split out for direct
 *  testing — confirmed against the TurboQuant fork's real --help output ("allowed values: ...
 *  turbo2, turbo3, turbo4") and ik_llama.cpp's (no such list near --cache-type-k at all). */
export function detectKvTypes(helpText: string, hasCacheTypeFlag: boolean): string[] {
  const kvTypes = hasCacheTypeFlag ? [...KNOWN_KV] : ['f16']
  const cacheTypeK = classifyFlag('--cache-type-k', helpText)
  if (cacheTypeK.kind === 'enum') {
    for (const extra of cacheTypeK.enumValues ?? []) if (!kvTypes.includes(extra)) kvTypes.push(extra)
  }
  return kvTypes
}

/** Parses a comma/pipe-separated list of accepted values out of a flag's own help block.
 *  Tries llama.cpp's own convention first ("allowed values: a, b, c", which may wrap onto a
 *  continuation line — see the KV-cache fixtures in probe.test.ts), then falls back to a
 *  bracket/pipe group (some forks print `[none|draft-mtp|nextn]` instead). Requires 2+ clean
 *  alphanumeric tokens to count as a real enum — a single bracketed word (e.g. "[beta]") is
 *  prose, not a value list, and would otherwise false-positive. Returns [] when nothing
 *  matches; NEVER guesses beyond what's actually printed. */
export function parseEnumList(blockText: string): string[] {
  const labeled = /allowed values:\s*([\s\S]+)/i.exec(blockText)
  const bracketed = /\[([^\]\n]+)\]/.exec(blockText)
  const raw = labeled?.[1] ?? bracketed?.[1]
  if (!raw) return []
  const values = raw
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter((s) => /^[a-z][a-z0-9_-]*$/i.test(s))
  return values.length >= 2 ? values : []
}

/** Classifies a probed flag's argument shape from its own --help block: 'enum' (a detected
 *  value list — drives a dropdown), 'boolean' (no argument — drives a checkbox), or 'valued'
 *  (takes an argument but no enum was found — drives a free-text input). Reuses the exact
 *  block-scoping boundary already proven in detectKvTypes (stop at the next flag line, a
 *  "(default" continuation, or a blank line) so a sibling flag's text — e.g.
 *  --cache-type-k-draft leaking into --cache-type-k — can't cross-contaminate. Best-effort by
 *  design (spec 22 §4): --help formatting is inconsistent across forks, so anything ambiguous
 *  or unparseable degrades to 'valued' — the safe default that never hides a flag or blocks a
 *  probe. */
export function classifyFlag(flagName: string, helpText: string): FlagInfo {
  const escaped = flagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s+(\\S+)\\b([\\s\\S]{0,400}?)(?=\\n\\s*\\(default|\\n\\s{2,}-[a-zA-Z]|\\n\\n|$)`, 'i')
  const m = re.exec(helpText)
  if (!m) return { name: flagName, kind: 'valued' }
  const placeholder = m[1]
  const block = m[2] ?? ''
  const enumValues = parseEnumList(block)
  if (enumValues.length > 0) return { name: flagName, kind: 'enum', enumValues }
  if (/^[A-Z][A-Z0-9_]*$/.test(placeholder)) return { name: flagName, kind: 'valued' }
  return { name: flagName, kind: 'boolean' }
}

function firstNonEmptyLine(s: string): string {
  for (const ln of s.split('\n')) {
    const t = ln.trim()
    if (t) return t
  }
  return ''
}
function lastLine(s: string): string {
  const lines = s.trim().split('\n')
  return lines.length ? trimLen(lines[lines.length - 1].trim(), 200) : ''
}
function trimLen(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}
