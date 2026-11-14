/** The declarative table behind GET and PATCH /api/v1/settings (scalability item 5.3, after ADR-333's declarative event
 *  template: one declaration per setting, everything else derived from it).
 *
 *  ## Shape
 *
 *  One {@link SettingRow} per top-level key of the GET payload, in payload order. A row's `read` builds that key's value
 *  (the payload and its TYPE are both derived from the rows), and its `fields` are the PATCH keys it owns, each with the
 *  JSON type it must have, how the raw value becomes the stored one (bounds come from config-bounds.ts, never restated),
 *  where it is written, whether only a hostGate caller may change it, and the side effect a save touching the row needs.
 *  A row may have no `read` (a write-only key such as `tavilyApiKey`) or no fields (a read-only key such as `mcp`).
 *
 *  Adding a setting: a row (or a field on an existing row) here, its type in src/contract/settings.ts, and, if the
 *  Settings screen gets a control for it, the UI. The route, the payload, validation and the host-only gate follow.
 *
 *  ## How PATCH reads it (parseSettingsPatch)
 *
 *  As the hand-written route did: first every field's JSON type, then every field's value (bounds, enums, the port and
 *  remote-provider guards), then the write. A body with several bad fields is refused for the first in table order.
 *
 *  ## Escape hatches
 *
 *  Settings whose rules are more than a type and a bound keep hand-written `parse`/`set`/`read` functions in their rows
 *  rather than a forced generic form: the port (remote access's ingress), the remote-access provider (409 while a
 *  tunnel is up, and it clears `enabled`), the search block and its legacy `tavilyApiKey` alias, the MCP list (env
 *  values and keys masked), and the write-only credentials. The listener rebind after a port or LAN change stays in
 *  the route (api/settings-routes.ts), which shapes the response around it. */
import { maskMcpEnv } from '../api/mcp-routes'
import {
  normalizeProvider, resolveIngressPort, VRAM_HEADROOM_MAX_MB, VRAM_HEADROOM_MIN_MB, VRAM_HEADROOM_SPILL_MB,
  type Config, type SearchConfig,
} from './config'
import {
  CHAT_APPROVAL_WAIT_MINUTES, CONFIG_BOUNDS, DOWNLOAD_CONCURRENCY, ENGINE_LOAD_STALL_SECONDS, GATEWAY_MAX_BODY_MB, KV_TYPE_MESSAGE,
  RETENTION_BOUNDS, coerceBounded, isConfigTheme, isKvTypeName, isWholeInBounds, type BoundedConfigPath, type LoadedBound,
} from './config-bounds'
import type { DaemonSettings } from '../contract/settings'

/** Why a PATCH is refused: the route answers `status` with `{ error: { code, message } }`. */
export class Refusal {
  constructor(readonly status: 400 | 409, readonly code: string, readonly message: string) {}
}

const invalid = (message: string) => new Refusal(400, 'invalid_config_value', message)

/** The JSON type a field must have, checked for every field before any value is. */
export type JsonType = 'boolean' | 'string' | 'number' | 'array'

/** What a field's `parse` needs beyond its own value. */
export interface PatchContext {
  /** The config the patch is applied to. */
  readonly stored: Config
  /** Remote access's runtime, when the daemon runs one (Deps.remote). */
  readonly remote?: {
    state(): { kind: string }
    ingressPort(): number | undefined
    targetIngressPort?(): number | undefined
  }
}

/** After a save, the route runs each effect a touched row names, in this order. */
export const SETTING_EFFECTS = ['rebuildTools', 'reportConsent', 'endStaleStreams', 'stopRemoteAccess'] as const
export type SettingEffect = (typeof SETTING_EFFECTS)[number]

/** Only a caller passing hostGate may change it: `label` is its name as the Settings screen words it, and `get` reads
 *  the stored value compared before and after the patch. */
export interface HostOnly {
  readonly label: string
  readonly get: (c: Config) => unknown
}

export interface SettingField {
  /** Dotted key in the PATCH body. */
  readonly key: string
  readonly type?: JsonType
  /** The value to store, or why it is refused. Without it the raw value (of `type`) is stored. */
  readonly parse?: (raw: unknown, ctx: PatchContext) => unknown
  readonly set: (cfg: Config, value: never) => void
  readonly hostOnly?: HostOnly
}

export interface SettingRow<K extends string = string, R = unknown> {
  /** Top-level key in the GET payload. */
  readonly key: K
  readonly read?: (c: Config) => R
  readonly fields: readonly SettingField[]
  /** Host-only as a whole: any change under it is refused, named by the row's key. */
  readonly hostOnly?: HostOnly
  /** Run on every PATCH, after every row's fields are written (the hand-written route's last step). */
  readonly alwaysWrite?: (cfg: Config) => void
  /** Run after a save whose body names this row's key. */
  readonly effect?: SettingEffect
}

// ── builders ──

/** The optional parts of a row besides its key, read and fields. */
type RowExtras = Pick<SettingRow, 'hostOnly' | 'alwaysWrite' | 'effect'>

function row<K extends string, R>(key: K, read: (c: Config) => R, fields: SettingField[] = [], extra: RowExtras = {}): SettingRow<K, R> & { read: (c: Config) => R } {
  return { key, read, fields, ...extra }
}

function writeOnly<K extends string>(key: K, fields: SettingField[], extra: RowExtras = {}): SettingRow<K, never> {
  return { key, fields, ...extra }
}

function field<V>(key: string, spec: { type?: JsonType; parse?: (raw: unknown, ctx: PatchContext) => V | Refusal; set: (cfg: Config, value: V) => void; hostOnly?: HostOnly }): SettingField {
  return { key, ...spec } as SettingField
}

/** A true/false field stored as sent. */
function bool(key: string, set: (cfg: Config, v: boolean) => void, hostOnly?: HostOnly): SettingField {
  return field<boolean>(key, { type: 'boolean', set, hostOnly })
}

/** A string field stored trimmed. */
function trimmed(key: string, set: (cfg: Config, v: string) => void, hostOnly?: HostOnly): SettingField {
  return field<string>(key, { type: 'string', parse: (raw) => (raw as string).trim(), set, hostOnly })
}

/** A modelDefaults / gateway number under its shared CONFIG_BOUNDS entry (the Turbo Link scope reads the same). */
function sharedBound(path: BoundedConfigPath, set: (cfg: Config, v: number) => void): SettingField {
  return field<number>(path, { parse: (raw) => coerceBounded(path, raw) ?? invalid(CONFIG_BOUNDS[path].message), set })
}

/** A whole number inside a config-bounds bound, refused with the bound's own message. */
function whole(key: string, bound: LoadedBound & { message: string }, set: (cfg: Config, v: number) => void, hostOnly?: HostOnly): SettingField {
  return field<number>(key, { parse: (raw) => (isWholeInBounds(raw, bound) ? raw : invalid(bound.message)), set, hostOnly })
}

/** A list of strings, each trimmed, empties dropped. `undefined` when `raw` is not an array of strings. */
function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((p: unknown) => typeof p === 'string')) return undefined
  return raw.map((p: string) => p.trim()).filter(Boolean)
}

const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|[\\/])/

// ── escape hatches: rules beyond a type and a bound ──

/** Listen port (spec 08 §2). config.validate() enforces 1024–65535 and would throw on update(); refused here for a clean
 *  400. The remote-access ingress port is fixed per boot (cli.ts resolves it against the port the main listener bound),
 *  and this change moves the main listener in place, at once. Onto that port while remote access is on (bound, starting
 *  or reconnecting, or enabled with a retry or Start still to bind it), the two collide: the rebind fails and reverts
 *  after the page was told to hop there, or the ingress cannot bind. While it is off this is taken, since nothing holds
 *  the port and the next boot moves the ingress off it (resolveIngressPort): refusing it then would keep the port from
 *  ever being picked here. GET /api/v1/remote/status then names no port for a self-run tunnel until that restart. */
function parsePort(raw: unknown, ctx: PatchContext): number | Refusal {
  const v = raw as number
  if (!Number.isInteger(v) || v < 1024 || v > 65535) return invalid('port must be 1024–65535.')
  const rc = ctx.remote
  if (rc && v !== ctx.stored.daemon.port && rc.targetIngressPort?.() === v) {
    const kind = rc.state().kind
    const on = rc.ingressPort() !== undefined || kind === 'starting' || kind === 'connected' || kind === 'reconnecting' || ctx.stored.remoteAccess.enabled
    if (on) return invalid(`port ${v} is remote access's own port while it is on; pick another, or turn remote access off first.`)
  }
  return v
}

/** Remote-access provider changes only while no tunnel is up. Saved mid-session, the new provider is what the next
 *  crash/health restart (or boot) starts — publishing the box through a provider whose exposure was never confirmed —
 *  while the UI already labels the still-running old tunnel with it.
 *  `enabled` as well: it stays true through failed / needs-setup / unavailable, and the next boot auto-starts whatever
 *  provider is saved. Not in `off`, though, where the UI shows remote access off and lets a provider be picked (its rule
 *  is "any state but off"), so a 409 there was a dead end. `enabled` can be set in `off`: a Start that raced a Stop from
 *  another client, or the moment at boot before the auto-start runs (a config booted with the experimental flag off has
 *  it cleared at boot, see clearEnabledWhileFlagOff). The change is taken and clears `enabled`, so nothing starts the new
 *  provider unconfirmed: not a later boot, and not this boot's pending start (cli.ts re-checks). */
function parseProvider(raw: unknown, ctx: PatchContext): { provider: ReturnType<typeof normalizeProvider>; clearsEnabled: boolean } | Refusal {
  const provider = normalizeProvider(raw)
  if (!ctx.remote) return { provider, clearsEnabled: false }
  const kind = ctx.remote.state().kind
  const running = kind === 'starting' || kind === 'connected' || kind === 'reconnecting'
  const enabled = ctx.stored.remoteAccess.enabled
  const changed = provider !== ctx.stored.remoteAccess.provider
  if (changed && (running || (kind !== 'off' && enabled))) {
    return new Refusal(409, 'remote_access_running', 'Turn remote access off before changing its provider.')
  }
  return { provider, clearsEnabled: changed && enabled }
}

/** VRAM headroom slider for auto-tune (bench.ts's overHeadroom). VRAM_HEADROOM_SPILL_MB (0) is a distinct, valid opt-in
 *  value — not part of the MIN_MB–MAX_MB safety-margin range, but not out-of-range either. */
function parseVramHeadroom(raw: unknown): number | Refusal {
  const v = raw as number
  const valid = v === VRAM_HEADROOM_SPILL_MB || (v >= VRAM_HEADROOM_MIN_MB && v <= VRAM_HEADROOM_MAX_MB)
  if (!Number.isFinite(v) || !valid) {
    return invalid(`vramHeadroomMb must be ${VRAM_HEADROOM_SPILL_MB} (allow VRAM spill) or ${VRAM_HEADROOM_MIN_MB}–${VRAM_HEADROOM_MAX_MB}.`)
  }
  return Math.round(v)
}

/** AGENTS.md candidate lists (Code's standing-context injection, persona.ts) — the OPPOSITE constraint from
 *  toolchainDirs: must be RELATIVE, not absolute. Clean-400 convenience only; persona.ts containment-checks each entry
 *  again at read time regardless (see config.ts's CodeConfig doc comment for why route-level validation alone isn't the
 *  real boundary). Each entry a string as well: String() stored a null or 5 as the filename "null" or "5". */
const MAX_AGENTS_MD_CANDIDATES = 8
function agentsMdCandidates(key: 'agentsMdProjectCandidates' | 'agentsMdGlobalCandidates'): SettingField {
  return field<string[]>(`code.${key}`, {
    parse: (raw) => {
      const list = stringList(raw)
      if (!list) return invalid(`code.${key} must be an array of filenames.`)
      if (list.length > MAX_AGENTS_MD_CANDIDATES) return invalid(`code.${key}: at most ${MAX_AGENTS_MD_CANDIDATES} candidates.`)
      const absolute = list.find((entry) => ABSOLUTE_PATH.test(entry))
      return absolute === undefined ? list : invalid(`code.${key}: "${absolute}" must be a relative filename/path, not absolute.`)
    },
    set: (c, v) => { c.code[key] = v },
  })
}

/** Search provider config (F-020). `search` is the canonical block; every key/URL is write-only and '' clears it. */
const searchBlock = (c: Config): SearchConfig => (c.tools.search ??= { provider: 'tavily' })
const orUndefined = (v: string): string | undefined => v.trim() || undefined
function searchSecret(key: 'tavilyApiKey' | 'kagiApiKey' | 'searxngUrl', label: string, get: HostOnly['get']): SettingField {
  return field<string>(`search.${key}`, { type: 'string', set: (c, v) => { searchBlock(c)[key] = orUndefined(v) }, hostOnly: { label, get } })
}

// ── the table ──

/** Data retention: lower limits (or the sweep switched on) delete gateway usage rows and old routine runs with the chats
 *  they made (chat/retention.ts), so only the host chooses them. */
const RETENTION_HOST_ONLY = 'data retention'

export const SETTINGS = [
  row('idleTtlMinutes', (c) => c.daemon.idleTtlMinutes, [
    field<number>('idleTtlMinutes', {
      type: 'number',
      parse: (raw) => (Number.isFinite(raw) && (raw as number) >= 0 ? raw as number : invalid('idleTtlMinutes must be a non-negative number.')),
      set: (c, v) => { c.daemon.idleTtlMinutes = v },
    }),
  ]),
  // Takes effect at once: the route rebinds the listener in place (spec 08 §2).
  row('port', (c) => c.daemon.port, [
    field<number>('port', { type: 'number', parse: parsePort, set: (c, v) => { c.daemon.port = v }, hostOnly: { label: 'the port', get: (c) => c.daemon.port } }),
  ]),
  // Enum shared with the Turbo Link config scope (config-bounds.ts) so the remote gate can never drift wider than this one.
  row('theme', (c) => c.daemon.theme, [
    field<string>('theme', { parse: (raw) => (isConfigTheme(raw) ? raw as string : invalid('theme must be system, light, or dark.')), set: (c, v) => { c.daemon.theme = v } }),
  ]),
  // Turbo Link machine name (ADR-376): what a linked peer displays for this box. '' is a legal value meaning "fall back
  // to the OS hostname" (link-routes.ts resolves it at handshake time), so this is a clear, not an error. Capped so a
  // peer's list can't be defaced by a kilobyte-long name. Echoed raw; not a secret.
  row('machineName', (c) => c.daemon.machineName ?? '', [
    field<string>('machineName', { type: 'string', parse: (raw) => (raw as string).trim().slice(0, 64), set: (c, v) => { c.daemon.machineName = v } }),
  ]),
  row('autoGenerateTitles', (c) => c.daemon.autoGenerateTitles, [bool('autoGenerateTitles', (c, v) => { c.daemon.autoGenerateTitles = v })]),
  row('autoMemoryEnabled', (c) => c.daemon.autoMemoryEnabled, [bool('autoMemoryEnabled', (c, v) => { c.daemon.autoMemoryEnabled = v })]),
  row('openBrowserOnStart', (c) => c.daemon.openBrowserOnStart, [bool('openBrowserOnStart', (c, v) => { c.daemon.openBrowserOnStart = v })]),
  row('autoLoadOnStart', (c) => c.autoLoadOnStart, [bool('autoLoadOnStart', (c, v) => { c.autoLoadOnStart = v })]),
  row('showAllEngineModels', (c) => c.showAllEngineModels, [bool('showAllEngineModels', (c, v) => { c.showAllEngineModels = v })]),
  row('vramHeadroomMb', (c) => c.vramHeadroomMb, [
    field<number>('vramHeadroomMb', { type: 'number', parse: parseVramHeadroom, set: (c, v) => { c.vramHeadroomMb = v } }),
  ]),
  // LAN expose toggle (spec 08 §2): the route rebinds in place. Settings that decide who may reach the daemon at all are
  // host-only (see hostOnlyChange).
  row('lanBind', (c) => c.daemon.lanBind, [
    bool('lanBind', (c, v) => { c.daemon.lanBind = v }, { label: 'LAN access', get: (c) => c.daemon.lanBind }),
  ]),
  // Require-API-key toggle (spec 06 §5). Off → open/unauthenticated LAN access. Turned on, it ends the streams a keyless
  // open-LAN peer opened while it was off (the route's endStaleStreams effect).
  row('requireApiKey', (c) => c.daemon.requireApiKey, [
    bool('requireApiKey', (c, v) => { c.daemon.requireApiKey = v }, { label: '"Require an API key"', get: (c) => c.daemon.requireApiKey }),
  ], { effect: 'endStaleStreams' }),
  // Telemetry consent level (spec 09 §3), surfaced as the 3-option enum. A changed level reports the consent choice once,
  // ever (the route's reportConsent effect).
  row('telemetryLevel', (c) => { const l = c.telemetry.level; return l === 'anon' || l === 'full' ? l : 'off' }, [
    field<string>('telemetryLevel', {
      parse: (raw) => (raw === 'off' || raw === 'anon' || raw === 'full' ? raw : invalid('telemetryLevel must be off, anon, or full.')),
      set: (c, v) => { c.telemetry.level = v },
    }),
  ], { effect: 'reportConsent' }),
  // Global model defaults (spec 05 §3): each supplied field checked against config-bounds.ts, which the Turbo Link config
  // scope reads too, so a bound changed here moves the remote gate with it; missing fields keep their value.
  row('modelDefaults', (c) => c.modelDefaults, [
    sharedBound('modelDefaults.ctx', (c, v) => { c.modelDefaults.ctx = v }),
    sharedBound('modelDefaults.ngl', (c, v) => { c.modelDefaults.ngl = v }),
    sharedBound('modelDefaults.imageMaxTokens', (c, v) => { c.modelDefaults.imageMaxTokens = v }),
    sharedBound('modelDefaults.maxTokens', (c, v) => { c.modelDefaults.maxTokens = v }),
    field<string>('modelDefaults.kvTypeK', { parse: (raw) => (isKvTypeName(raw) ? raw : invalid(KV_TYPE_MESSAGE)), set: (c, v) => { c.modelDefaults.kvTypeK = v } }),
    field<string>('modelDefaults.kvTypeV', { parse: (raw) => (isKvTypeName(raw) ? raw : invalid(KV_TYPE_MESSAGE)), set: (c, v) => { c.modelDefaults.kvTypeV = v } }),
  ]),
  // ComfyUI coordination: the master toggle + the reverse-gate fields (F-011); the gate node's install path is owned by
  // the /comfyui/install + /uninstall endpoints. `url` is empty or an http(s):// origin (config.validate() checks it too).
  // KV prompt-cache persistence (cachePersist) is PARKED (ADR-053): not writable here, so the product never enables it.
  row('comfyui', (c) => c.comfyui, [
    bool('comfyui.enabled', (c, v) => { c.comfyui.enabled = v }),
    bool('comfyui.reverseGate', (c, v) => { c.comfyui.reverseGate = v }),
    field<string>('comfyui.url', {
      parse: (raw) => {
        if (typeof raw !== 'string') return invalid('comfyui.url must be a string: an http(s):// origin, or empty.')
        const u = raw.trim()
        return u && !/^https?:\/\//i.test(u) ? invalid('comfyui.url must be an http(s):// origin (e.g. http://127.0.0.1:8188).') : u
      },
      set: (c, v) => { c.comfyui.url = v },
    }),
  ]),
  // Gateway intelligence (v0.6.0): auto-swap toggle + keep-N pool size, and the /v1 body cap (read per request, host-only:
  // raising it raises what this machine buffers).
  row('gateway', (c) => c.gateway, [
    bool('gateway.autoSwap', (c, v) => { c.gateway.autoSwap = v }),
    sharedBound('gateway.keepN', (c, v) => { c.gateway.keepN = v }),
    whole('gateway.maxBodyMb', GATEWAY_MAX_BODY_MB, (c, v) => { c.gateway.maxBodyMb = v }, { label: 'the gateway request size limit', get: (c) => c.gateway.maxBodyMb }),
  ]),
  // Developer request log (issue #211 follow-up), per field. Body capture records Code sessions' and `turbollm launch`
  // agents' full prompts, which only a hostGate caller may read back (REQUEST_BODIES_HOST_ONLY); switching it on from
  // elsewhere was the way to start that capture. Turning the log off hides from the owner what was sent.
  row('requestLog', (c) => c.requestLog, [
    bool('requestLog.enabled', (c, v) => { c.requestLog.enabled = v }, { label: 'the request log', get: (c) => c.requestLog.enabled }),
    bool('requestLog.captureBodies', (c, v) => { c.requestLog.captureBodies = v }, { label: '"Log prompts and responses"', get: (c) => c.requestLog.captureBodies }),
  ]),
  row('retention', (c) => c.retention, [
    bool('retention.enabled', (c, v) => { c.retention.enabled = v }, { label: RETENTION_HOST_ONLY, get: (c) => c.retention.enabled }),
    whole('retention.apiUsageRawDays', RETENTION_BOUNDS.apiUsageRawDays, (c, v) => { c.retention.apiUsageRawDays = v }, { label: RETENTION_HOST_ONLY, get: (c) => c.retention.apiUsageRawDays }),
    whole('retention.routineRunsKept', RETENTION_BOUNDS.routineRunsKept, (c, v) => { c.retention.routineRunsKept = v }, { label: RETENTION_HOST_ONLY, get: (c) => c.retention.routineRunsKept }),
  ]),
  // The HF token is write-only over the wire (spec 10 §4): never echoed back, only whether one is set. '' clears it.
  row('hfTokenSet', (c) => c.hf.token.length > 0, [
    trimmed('hfToken', (c, v) => { c.hf.token = v }, { label: 'the Hugging Face token', get: (c) => c.hf.token }),
  ]),
  // GitHub token, same semantics: raises the GitHub API rate limit from 60 to 5,000 requests/hour.
  row('ghTokenSet', (c) => (c.gh?.token ?? '').length > 0, [
    trimmed('ghToken', (c, v) => { (c.gh ??= { token: '' }).token = v }, { label: 'the GitHub token', get: (c) => c.gh?.token ?? '' }),
  ]),
  // Legacy mirror of search.tavilyKeySet.
  row('tavilyKeySet', (c) => !!(c.tools.search?.tavilyApiKey ?? c.tools.tavily?.apiKey)),
  // Search provider config (F-020): provider + which credentials are set; searxngUrl is not a secret so it is echoed. The
  // block is created on every save. Host-only field by field (the save always creates the block). A save naming it
  // rebuilds the tool definitions so the engine picks up the provider without a restart (rebuildTools).
  row('search', (c) => ({
    provider: c.tools.search?.provider ?? 'tavily',
    tavilyKeySet: !!c.tools.search?.tavilyApiKey,
    kagiKeySet: !!c.tools.search?.kagiApiKey,
    searxngUrl: c.tools.search?.searxngUrl ?? '',
  }), [
    // An unknown provider is ignored, not refused.
    field<unknown>('search.provider', {
      set: (c, v) => { if (v === 'tavily' || v === 'kagi' || v === 'searxng') searchBlock(c).provider = v },
    }),
    searchSecret('tavilyApiKey', 'the Tavily API key', (c) => [c.tools.search?.tavilyApiKey, c.tools.tavily?.apiKey]),
    searchSecret('kagiApiKey', 'the Kagi API key', (c) => c.tools.search?.kagiApiKey),
    searchSecret('searxngUrl', 'the SearXNG URL', (c) => c.tools.search?.searxngUrl),
  ], { alwaysWrite: searchBlock, effect: 'rebuildTools' }),
  // Legacy alias: top-level tavilyApiKey maps onto search.tavilyApiKey and keeps tools.tavily for read. Written after the
  // search block, so it wins over search.tavilyApiKey in the same body. Host-only through search.tavilyApiKey's check.
  writeOnly('tavilyApiKey', [
    trimmed('tavilyApiKey', (c, key) => {
      const search = searchBlock(c)
      c.tools.tavily = key ? { apiKey: key } : undefined
      search.tavilyApiKey = key || undefined
    }),
  ], { effect: 'rebuildTools' }),
  // apiKey is write-only: stripped so Bearer tokens never reach the frontend; apiKeySet says only whether one is stored,
  // so the edit form can show it and offer a clear. A stdio server's env values are write-only as well: key names only.
  row('mcp', (c) => ({ ...c.mcp, servers: c.mcp.servers.map(({ apiKey: k, ...s }) => ({ ...maskMcpEnv(s), apiKeySet: !!k })) })),
  // Build toolchain dirs (ADR-100): absolute folders prepended to PATH for the prereq probe + 1-click build, so a
  // conda-env / custom-path CUDA Toolkit is found. First on PATH for the prereq probe (ungated) and every build, which run
  // git/cmake/nvcc/the compiler from there: a directory of the caller's own, or a UNC share on Windows (it passes the
  // absolute-path check), is command execution — host-only. Each entry a string too: String() made ['/x'] the path '/x'.
  row('build', (c) => ({ toolchainDirs: c.build.toolchainDirs }), [
    field<string[]>('build.toolchainDirs', {
      parse: (raw) => {
        const dirs = stringList(raw)
        if (!dirs) return invalid('build.toolchainDirs must be an array of paths.')
        const relative = dirs.find((dir) => !ABSOLUTE_PATH.test(dir))
        return relative === undefined ? dirs : invalid(`build.toolchainDirs: "${relative}" must be an absolute path.`)
      },
      set: (c, v) => { c.build.toolchainDirs = v },
      hostOnly: { label: 'the build toolchain folders', get: (c) => c.build.toolchainDirs },
    }),
  ]),
  row('code', (c) => c.code, [
    agentsMdCandidates('agentsMdProjectCandidates'),
    agentsMdCandidates('agentsMdGlobalCandidates'),
    // Which coding agent new Code sessions launch with: a clean 400 on garbage rather than a silent fallback at read time.
    field<'turbollm' | 'pi' | 'claude' | 'opencode'>('code.defaultAgent', {
      parse: (raw) => (raw === 'turbollm' || raw === 'pi' || raw === 'claude' || raw === 'opencode'
        ? raw : invalid('code.defaultAgent must be one of: turbollm, pi, claude, opencode.')),
      set: (c, v) => { c.code.defaultAgent = v },
    }),
  ]),
  // Cloud Launch deploy-link settings (ADR-153): the RunPod Template ID the user published themselves — not a secret.
  row('cloudDeploy', (c) => c.cloudDeploy, [trimmed('cloudDeploy.runpodTemplateId', (c, v) => { c.cloudDeploy.runpodTemplateId = v })]),
  // Experimental feature flags (2026-07-14), per field. Remote access switched off stops a UI-managed tunnel, as Stop
  // would, since every /api/v1/remote/* route refuses from then on (the route's stopRemoteAccess effect).
  row('experimental', (c) => c.daemon.experimental, [
    bool('experimental.memory', (c, v) => { c.daemon.experimental.memory = v }),
    bool('experimental.cloudDeploy', (c, v) => { c.daemon.experimental.cloudDeploy = v }),
    bool('experimental.routines', (c, v) => { c.daemon.experimental.routines = v }),
    bool('experimental.turboLink', (c, v) => { c.daemon.experimental.turboLink = v }),
    bool('experimental.remoteAccess', (c, v) => { c.daemon.experimental.remoteAccess = v }, { label: 'remote access', get: (c) => c.daemon.experimental.remoteAccess }),
    // Host-only: a remote caller must not be able to switch on code execution on this machine.
    bool('experimental.sandbox', (c, v) => { c.daemon.experimental.sandbox = v }, { label: 'the Python sandbox', get: (c) => c.daemon.experimental.sandbox }),
  ], { effect: 'stopRemoteAccess' }),
  // Tool-call approval gate: global per-tool policy map, every value ask | allow | deny.
  row('toolPolicies', (c) => c.tools.toolPolicies ?? {}, [
    field<Record<string, 'ask' | 'allow' | 'deny'>>('toolPolicies', {
      parse: (raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return invalid('toolPolicies must be an object mapping tool name to ask, allow, or deny.')
        }
        const validated: Record<string, 'ask' | 'allow' | 'deny'> = {}
        for (const [toolName, v] of Object.entries(raw)) {
          if (v !== 'ask' && v !== 'allow' && v !== 'deny') return invalid(`toolPolicies.${toolName} must be ask, allow, or deny.`)
          validated[toolName] = v
        }
        return validated
      },
      set: (c, v) => { c.tools.toolPolicies = v },
      hostOnly: { label: 'tool permissions', get: (c) => c.tools.toolPolicies },
    }),
  ]),
  row('autoAllowAll', (c) => c.tools.autoAllowAll ?? false, [
    bool('autoAllowAll', (c, v) => { c.tools.autoAllowAll = v }, { label: '"Auto-allow all"', get: (c) => c.tools.autoAllowAll }),
  ]),
  // How long a chat reply waits for its tool calls' approvals (execute-with-approval.ts). Not host-only like
  // toolPolicies: the wait running out runs nothing (the call is answered as not run), so no value of it lets a tool run.
  row('chatApprovalWaitMinutes', (c) => c.tools.chatApprovalWaitMinutes ?? CHAT_APPROVAL_WAIT_MINUTES.default, [
    whole('chatApprovalWaitMinutes', CHAT_APPROVAL_WAIT_MINUTES, (c, v) => { c.tools.chatApprovalWaitMinutes = v }),
  ]),
  // Remote access (ADR-422): per-field merge, never Object.assign — a patch setting only the provider must not wipe a
  // stored tunnel token. Secrets are WRITE-ONLY: the booleans say whether one is stored. Host-only as a whole.
  row('remoteAccess', (c) => ({
    enabled: c.remoteAccess.enabled,
    provider: c.remoteAccess.provider,
    ingressPort: c.remoteAccess.ingressPort,
    cloudflare: {
      hasTunnelToken: !!c.remoteAccess.cloudflare.tunnelToken,
      hostname: c.remoteAccess.cloudflare.hostname,
      accessTeamDomain: c.remoteAccess.cloudflare.accessTeamDomain,
      accessAud: c.remoteAccess.cloudflare.accessAud,
      requireAccess: c.remoteAccess.cloudflare.requireAccess,
    },
    ngrok: { hasAuthtoken: !!c.remoteAccess.ngrok.authtoken, domain: c.remoteAccess.ngrok.domain },
    tailscale: { port: c.remoteAccess.tailscale.port },
    custom: { publicUrl: c.remoteAccess.custom.publicUrl },
    // Not a secret — a capability list. sanitizeTokenGrant (remote/routes.ts) enforces the LINK_CAPABILITIES allow-list
    // where a token is minted; only the shape is enforced here.
    tokenGrant: c.remoteAccess.tokenGrant,
    lastUrl: c.remoteAccess.lastUrl,
  }), [
    field<{ provider: ReturnType<typeof normalizeProvider>; clearsEnabled: boolean }>('remoteAccess.provider', {
      parse: parseProvider,
      set: (c, v) => {
        c.remoteAccess.provider = v.provider
        if (v.clearsEnabled) c.remoteAccess.enabled = false
      },
    }),
    // Resolved against the daemon port, which the port row (earlier in the table) has already written.
    field<number>('remoteAccess.ingressPort', { type: 'number', set: (c, v) => { c.remoteAccess.ingressPort = resolveIngressPort(v, c.daemon.port) } }),
    trimmed('remoteAccess.cloudflare.tunnelToken', (c, v) => { c.remoteAccess.cloudflare.tunnelToken = v }),
    trimmed('remoteAccess.cloudflare.hostname', (c, v) => { c.remoteAccess.cloudflare.hostname = v }),
    trimmed('remoteAccess.cloudflare.accessTeamDomain', (c, v) => { c.remoteAccess.cloudflare.accessTeamDomain = v }),
    trimmed('remoteAccess.cloudflare.accessAud', (c, v) => { c.remoteAccess.cloudflare.accessAud = v }),
    bool('remoteAccess.cloudflare.requireAccess', (c, v) => { c.remoteAccess.cloudflare.requireAccess = v }),
    trimmed('remoteAccess.ngrok.authtoken', (c, v) => { c.remoteAccess.ngrok.authtoken = v }),
    trimmed('remoteAccess.ngrok.domain', (c, v) => { c.remoteAccess.ngrok.domain = v }),
    field<number>('remoteAccess.tailscale.port', { type: 'number', set: (c, p) => { c.remoteAccess.tailscale.port = p === 8443 || p === 10000 ? p : 443 } }),
    trimmed('remoteAccess.custom.publicUrl', (c, v) => { c.remoteAccess.custom.publicUrl = v }),
    field<unknown[]>('remoteAccess.tokenGrant.capabilities', {
      type: 'array',
      set: (c, v) => { c.remoteAccess.tokenGrant.capabilities = v.filter((x): x is string => typeof x === 'string') },
    }),
    field<unknown[]>('remoteAccess.tokenGrant.models', {
      type: 'array',
      set: (c, v) => { c.remoteAccess.tokenGrant.models = v.filter((x): x is string => typeof x === 'string') },
    }),
  ], { hostOnly: { label: 'remote access', get: (c) => c.remoteAccess } }),
  // Scalability tier 4's runtime limits, read per use (downloads per pump, the stall watch per load), so a save applies
  // to the next one. Host-only, and no Settings screen control.
  row('downloadConcurrency', (c) => c.downloadConcurrency, [
    whole('downloadConcurrency', DOWNLOAD_CONCURRENCY, (c, v) => { c.downloadConcurrency = v }, { label: 'parallel downloads', get: (c) => c.downloadConcurrency }),
  ]),
  row('engineLoadStallSeconds', (c) => c.engineLoadStallSeconds, [
    whole('engineLoadStallSeconds', ENGINE_LOAD_STALL_SECONDS, (c, v) => { c.engineLoadStallSeconds = v }, { label: 'the engine load stall timeout', get: (c) => c.engineLoadStallSeconds }),
  ]),
] as const

type Readable = Extract<(typeof SETTINGS)[number], { read: (c: Config) => unknown }>

/** The GET /api/v1/settings payload, derived from the table. */
export type SettingsPayload = { [R in Readable as R['key']]: ReturnType<R['read']> }

// The shared contract (src/contract/settings.ts) must name exactly the payload's keys and accept every value.
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false
const contractMatchesTable: SameKeys<SettingsPayload, DaemonSettings> = true
const payloadFitsContract = (p: SettingsPayload): DaemonSettings => p
void contractMatchesTable
void payloadFitsContract

/** The GET /api/v1/settings payload for `cfg`: each readable row's value, in table order. */
export function settingsView(cfg: Config): SettingsPayload {
  const payload: Record<string, unknown> = {}
  for (const r of SETTINGS as readonly SettingRow[]) if (r.read) payload[r.key] = r.read(cfg)
  return payload as SettingsPayload
}

/** A checked patch: `apply` writes it into a config (the route applies it to a trial copy first for the host-only
 *  check, then through the store), and `effects` are what the route runs after the save. */
export interface ParsedPatch {
  readonly apply: (cfg: Config) => void
  readonly effects: SettingEffect[]
}

const keyPaths = new Map<string, string[]>()
function at(body: unknown, key: string): unknown {
  let path = keyPaths.get(key)
  if (!path) keyPaths.set(key, (path = key.split('.')))
  let v = body
  for (const k of path) v = (v as Record<string, unknown> | null | undefined)?.[k]
  return v
}

function typeMessage(key: string, type: JsonType): string {
  if (type === 'boolean') return `${key} must be true or false.`
  if (type === 'array') return `${key} must be an array of strings.`
  return `${key} must be a ${type}.`
}

function hasType(v: unknown, type: JsonType): boolean {
  return type === 'array' ? Array.isArray(v) : typeof v === type
}

/** Checks a PATCH body against the table: every field's JSON type first, then every value, as the hand-written route
 *  did. Nothing is written; the refusal is the first bad field in table order. */
export function parseSettingsPatch(body: Record<string, unknown>, ctx: PatchContext): ParsedPatch | Refusal {
  const rows = SETTINGS as readonly SettingRow[]
  const present = rows.flatMap((r) => r.fields).flatMap((f) => {
    const raw = at(body, f.key)
    return raw === undefined ? [] : [{ f, raw }]
  })
  for (const { f, raw } of present) if (f.type && !hasType(raw, f.type)) return invalid(typeMessage(f.key, f.type))
  const values = new Map<SettingField, unknown>()
  for (const { f, raw } of present) {
    const v = f.parse ? f.parse(raw, ctx) : raw
    if (v instanceof Refusal) return v
    values.set(f, v)
  }
  const apply = (cfg: Config): void => {
    for (const r of rows) for (const f of r.fields) if (values.has(f)) f.set(cfg, values.get(f) as never)
    for (const r of rows) r.alwaysWrite?.(cfg)
  }
  const touched = new Set(rows.filter((r) => r.effect && body[r.key] !== undefined).map((r) => r.effect))
  return { apply, effects: SETTING_EFFECTS.filter((e) => touched.has(e)) }
}

/** The first host-only setting that `after` changes from `before`, as `field` (its PATCH key) and `label`, or null.
 *  Judged on the outcome, not on which fields a body names, so a save that echoes a stored value unchanged passes. */
export function hostOnlyChange(before: Config, after: Config): { field: string; label: string } | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const r of SETTINGS as readonly SettingRow[]) {
    const checks = [...(r.hostOnly ? [{ field: r.key, ...r.hostOnly }] : []), ...r.fields.flatMap((f) => (f.hostOnly ? [{ field: f.key, ...f.hostOnly }] : []))]
    for (const { field: name, label, get } of checks) if (!same(get(before), get(after))) return { field: name, label }
  }
  return null
}
