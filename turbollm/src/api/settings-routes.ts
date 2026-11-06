// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { normalizeProvider, resolveIngressPort, VRAM_HEADROOM_MIN_MB, VRAM_HEADROOM_MAX_MB, VRAM_HEADROOM_SPILL_MB, type Config } from '../config/config'
import { CHAT_APPROVAL_WAIT_MINUTES, CONFIG_BOUNDS, KV_TYPE_MESSAGE, RETENTION_BOUNDS, coerceBounded, isChatApprovalWaitMinutes, isConfigTheme, isKvTypeName, isRetentionValue } from '../config/config-bounds'
import type { Deps } from '../deps'
import { endStaleStreams, hostGate } from '../auth'
import { sendConsentChoice } from '../telemetry/consent'
import { stopRemoteAccess } from '../remote/routes'
import { err, jsonBody } from './http'
import { maskMcpEnv } from './mcp-routes'

/** GET and PATCH /api/v1/settings: the UI-exposed settings subset. */
export function registerSettingsRoutes(app: Hono, d: Deps): void {
  // ── daemon settings (UI-exposed subset) ──
  app.get('/api/v1/settings', (c) => c.json(settingsPayload(d)))

  app.patch('/api/v1/settings', async (c) => {
    // jsonBody, not body(): a body that is not an object is refused below, not taken as an empty patch.
    const b = await jsonBody(c) as {
      idleTtlMinutes?: number
      port?: number
      theme?: string
      machineName?: string
      autoGenerateTitles?: boolean
      autoMemoryEnabled?: boolean
      openBrowserOnStart?: boolean
      autoLoadOnStart?: boolean
      showAllEngineModels?: boolean
      vramHeadroomMb?: number
      lanBind?: boolean
      requireApiKey?: boolean
      telemetryLevel?: string
      modelDefaults?: { ctx?: number; ngl?: number; imageMaxTokens?: number; maxTokens?: number; kvTypeK?: string; kvTypeV?: string }
      hfToken?: string
      comfyui?: { enabled?: boolean; url?: string; reverseGate?: boolean }
      gateway?: { autoSwap?: boolean; keepN?: number }
      requestLog?: { enabled?: boolean; captureBodies?: boolean }
      retention?: { enabled?: boolean; apiUsageRawDays?: number; routineRunsKept?: number }
      tavilyApiKey?: string
      search?: { provider?: string; tavilyApiKey?: string; kagiApiKey?: string; searxngUrl?: string }
      ghToken?: string
      build?: { toolchainDirs?: string[] }
      code?: { agentsMdProjectCandidates?: string[]; agentsMdGlobalCandidates?: string[]; defaultAgent?: string }
      toolPolicies?: Record<string, string>
      autoAllowAll?: boolean
      chatApprovalWaitMinutes?: number
      cloudDeploy?: { runpodTemplateId?: string }
      experimental?: { memory?: boolean; cloudDeploy?: boolean; routines?: boolean; turboLink?: boolean; remoteAccess?: boolean }
      remoteAccess?: {
        provider?: string
        ingressPort?: number
        cloudflare?: {
          tunnelToken?: string
          hostname?: string
          accessTeamDomain?: string
          accessAud?: string
          requireAccess?: boolean
        }
        ngrok?: { authtoken?: string; domain?: string }
        tailscale?: { port?: number }
        custom?: { publicUrl?: string }
        tokenGrant?: { capabilities?: string[]; models?: string[] }
      }
    }

    // The types above are what the Settings screen sends, not a check. A JSON `null` body threw
    // at the first field read below, and a wrong JSON type in a field read with a string or array
    // method (comfyui.url, the search keys, remoteAccess.tokenGrant) threw there or inside
    // apply(): every one went out as Hono's bare text/plain 500. Checked here and next to each
    // such field, before anything is applied. A body that is any other non-object (an array, a
    // string) was an empty patch; it is refused the same way.
    if (typeof b !== 'object' || b === null || Array.isArray(b)) {
      return err(c, 400, 'invalid_config_value', 'The settings patch must be a JSON object.')
    }
    for (const f of ['tavilyApiKey', 'kagiApiKey', 'searxngUrl'] as const) {
      const v: unknown = b.search?.[f]
      if (v !== undefined && typeof v !== 'string') return err(c, 400, 'invalid_config_value', `search.${f} must be a string.`)
    }
    for (const f of ['capabilities', 'models'] as const) {
      const v: unknown = b.remoteAccess?.tokenGrant?.[f]
      if (v !== undefined && !Array.isArray(v)) return err(c, 400, 'invalid_config_value', `remoteAccess.tokenGrant.${f} must be an array of strings.`)
    }
    // Every other field below is read with `!!`, String() or Number() (modelDefaults.* and
    // gateway.keepN through coerceBounded), which took any JSON type and stored what that made of
    // it, with a 200: "false" turned lanBind (a rebind onto the LAN) or autoAllowAll on, null
    // turned requireApiKey or Cloudflare Access off, stored a token as the text "null", and made
    // vramHeadroomMb 0 (VRAM spill). The Settings screen sends each as its own JSON type, so
    // anything else is refused here, null included, before anything is applied.
    const raBody = b.remoteAccess
    const typed: Array<[string, unknown, 'boolean' | 'string' | 'number']> = [
      ['idleTtlMinutes', b.idleTtlMinutes, 'number'],
      ['port', b.port, 'number'],
      ['vramHeadroomMb', b.vramHeadroomMb, 'number'],
      ['machineName', b.machineName, 'string'],
      ['hfToken', b.hfToken, 'string'],
      ['ghToken', b.ghToken, 'string'],
      ['tavilyApiKey', b.tavilyApiKey, 'string'],
      ['cloudDeploy.runpodTemplateId', b.cloudDeploy?.runpodTemplateId, 'string'],
      ...(['autoGenerateTitles', 'autoMemoryEnabled', 'openBrowserOnStart', 'autoLoadOnStart', 'showAllEngineModels', 'lanBind', 'requireApiKey', 'autoAllowAll'] as const)
        .map((f): [string, unknown, 'boolean'] => [f, b[f], 'boolean']),
      ['comfyui.enabled', b.comfyui?.enabled, 'boolean'],
      ['comfyui.reverseGate', b.comfyui?.reverseGate, 'boolean'],
      ['gateway.autoSwap', b.gateway?.autoSwap, 'boolean'],
      ['requestLog.enabled', b.requestLog?.enabled, 'boolean'],
      ['requestLog.captureBodies', b.requestLog?.captureBodies, 'boolean'],
      ['retention.enabled', b.retention?.enabled, 'boolean'],
      ...(['memory', 'cloudDeploy', 'routines', 'turboLink', 'remoteAccess'] as const)
        .map((f): [string, unknown, 'boolean'] => [`experimental.${f}`, b.experimental?.[f], 'boolean']),
      ['remoteAccess.ingressPort', raBody?.ingressPort, 'number'],
      ['remoteAccess.tailscale.port', raBody?.tailscale?.port, 'number'],
      ['remoteAccess.cloudflare.requireAccess', raBody?.cloudflare?.requireAccess, 'boolean'],
      ...(['tunnelToken', 'hostname', 'accessTeamDomain', 'accessAud'] as const)
        .map((f): [string, unknown, 'string'] => [`remoteAccess.cloudflare.${f}`, raBody?.cloudflare?.[f], 'string']),
      ['remoteAccess.ngrok.authtoken', raBody?.ngrok?.authtoken, 'string'],
      ['remoteAccess.ngrok.domain', raBody?.ngrok?.domain, 'string'],
      ['remoteAccess.custom.publicUrl', raBody?.custom?.publicUrl, 'string'],
    ]
    for (const [field, v, type] of typed) {
      if (v !== undefined && typeof v !== type) {
        return err(c, 400, 'invalid_config_value', `${field} must be ${type === 'boolean' ? 'true or false' : `a ${type}`}.`)
      }
    }

    const updates: Record<string, unknown> = {}
    if (b.idleTtlMinutes !== undefined) {
      const v = Number(b.idleTtlMinutes)
      if (!Number.isFinite(v) || v < 0) return err(c, 400, 'invalid_config_value', 'idleTtlMinutes must be a non-negative number.')
      updates.idleTtlMinutes = v
    }
    // Listen port (spec 08 §2). Takes effect on the next daemon restart; the UI shows
    // a "restart required" note. config.validate() also enforces the 1024–65535 floor.
    if (b.port !== undefined) {
      const v = Number(b.port)
      // config.validate() enforces 1024–65535 and would throw on update() otherwise;
      // reject out-of-range here so the client gets a clean 400, not a 500.
      if (!Number.isInteger(v) || v < 1024 || v > 65535) return err(c, 400, 'invalid_config_value', 'port must be 1024–65535.')
      // The remote-access ingress port is fixed per boot (cli.ts resolves it against the port
      // the main listener bound), and this change moves the main listener in place, at once.
      // Onto that port while remote access is on (bound, starting or reconnecting, or enabled
      // with a retry or Start still to bind it), the two collide: the rebind fails and reverts
      // after the page was told to hop there, or the ingress cannot bind. While it is off this
      // is taken, since nothing holds the port and the next boot moves the ingress off it
      // (resolveIngressPort): refusing it then would keep the port from ever being picked here.
      // GET /api/v1/remote/status then names no port for a self-run tunnel until that restart.
      const rc = d.remote
      if (rc && v !== d.store.snapshot().daemon.port && rc.targetIngressPort?.() === v) {
        const kind = rc.state().kind
        const on = rc.ingressPort() !== undefined || kind === 'starting' || kind === 'connected' || kind === 'reconnecting' || d.store.snapshot().remoteAccess.enabled
        if (on) return err(c, 400, 'invalid_config_value', `port ${v} is remote access's own port while it is on; pick another, or turn remote access off first.`)
      }
      updates.port = v
    }
    if (b.theme !== undefined) {
      // Enum shared with the Turbo Link config scope (config-bounds.ts) so the remote gate
      // can never drift wider than this one.
      if (!isConfigTheme(b.theme)) return err(c, 400, 'invalid_config_value', 'theme must be system, light, or dark.')
      updates.theme = b.theme
    }
    // Turbo Link machine name (ADR-376): what a linked peer displays for this box. '' is a
    // legal value meaning "fall back to the OS hostname" (link-routes.ts resolves it), so
    // this is a clear, not an error. Capped so a peer's list can't be defaced by a
    // kilobyte-long name.
    if (b.machineName !== undefined) updates.machineName = String(b.machineName).trim().slice(0, 64)
    if (b.autoGenerateTitles !== undefined) updates.autoGenerateTitles = !!b.autoGenerateTitles
    if (b.autoMemoryEnabled !== undefined) updates.autoMemoryEnabled = !!b.autoMemoryEnabled
    if (b.openBrowserOnStart !== undefined) updates.openBrowserOnStart = !!b.openBrowserOnStart

    // VRAM headroom slider for auto-tune (bench.ts's overHeadroom). config.validate() also
    // enforces this range and would throw on update() otherwise; reject here for a clean 400.
    let vramHeadroomMb: number | undefined
    if (b.vramHeadroomMb !== undefined) {
      const v = Number(b.vramHeadroomMb)
      // VRAM_HEADROOM_SPILL_MB (0) is a distinct, valid opt-in value — not part of the
      // MIN_MB–MAX_MB safety-margin range, but not out-of-range either.
      const valid = v === VRAM_HEADROOM_SPILL_MB || (v >= VRAM_HEADROOM_MIN_MB && v <= VRAM_HEADROOM_MAX_MB)
      if (!Number.isFinite(v) || !valid) {
        return err(c, 400, 'invalid_config_value', `vramHeadroomMb must be ${VRAM_HEADROOM_SPILL_MB} (allow VRAM spill) or ${VRAM_HEADROOM_MIN_MB}–${VRAM_HEADROOM_MAX_MB}.`)
      }
      vramHeadroomMb = Math.round(v)
    }
    // LAN expose toggle (spec 08 §2). Persist only; auto daemon-restart is deferred —
    // the UI tells the user to restart to apply.
    if (b.lanBind !== undefined) updates.lanBind = !!b.lanBind
    // Require-API-key toggle (spec 06 §5). Off → open/unauthenticated LAN access.
    if (b.requireApiKey !== undefined) updates.requireApiKey = !!b.requireApiKey

    // Telemetry consent level (spec 09 §3): off | anon | full. Validate the enum.
    let telemetryLevel: string | undefined
    const prevTelemetryLevel = d.store.snapshot().telemetry.level
    if (b.telemetryLevel !== undefined) {
      if (!['off', 'anon', 'full'].includes(b.telemetryLevel)) {
        return err(c, 400, 'invalid_config_value', 'telemetryLevel must be off, anon, or full.')
      }
      telemetryLevel = b.telemetryLevel
    }

    // Global model defaults (spec 05 §3): validate the supplied fields; missing
    // fields keep their current value (partial patch).
    const md = b.modelDefaults
    const mdUpdates: { ctx?: number; ngl?: number; imageMaxTokens?: number; maxTokens?: number; kvTypeK?: string; kvTypeV?: string } = {}
    if (md) {
      // Bounds + messages come from config-bounds.ts, which the Turbo Link config scope
      // reads too. Task 3's review found the remote gate had drifted WIDER than this route
      // (it accepted ctx < 256 and ngl = -1, neither of which config.validate() catches, so
      // the value persisted). One table is what stops that recurring — a bound changed here
      // moves the remote gate with it.
      for (const f of ['ctx', 'ngl', 'imageMaxTokens', 'maxTokens'] as const) {
        if (md[f] === undefined) continue
        const v = coerceBounded(`modelDefaults.${f}`, md[f])
        if (v === null) return err(c, 400, 'invalid_config_value', CONFIG_BOUNDS[`modelDefaults.${f}`].message)
        mdUpdates[f] = v
      }
      for (const f of ['kvTypeK', 'kvTypeV'] as const) {
        if (md[f] === undefined) continue
        if (!isKvTypeName(md[f])) return err(c, 400, 'invalid_config_value', KV_TYPE_MESSAGE)
        mdUpdates[f] = md[f]
      }
    }

    // ComfyUI coordination: the master toggle + the reverse-gate fields (F-011) are set
    // here — the gate node's install path is owned by the /comfyui/install + /uninstall
    // endpoints. `url` is validated by config.validate() (empty or http(s):// origin);
    // reject a malformed origin here so the client gets a clean 400, not a 500.
    // KV prompt-cache persistence (F-014, cachePersist) is PARKED (ADR-053): the code is
    // kept but intentionally not exposed — no Settings toggle and not writable here, so the
    // product never enables it. It defaults off and is only reachable by hand-editing
    // config.json. See src/engines/slot-cache.ts.
    const cuUpdates: { enabled?: boolean; url?: string; reverseGate?: boolean } = {}
    if (b.comfyui?.enabled !== undefined) cuUpdates.enabled = !!b.comfyui.enabled
    if (b.comfyui?.reverseGate !== undefined) cuUpdates.reverseGate = !!b.comfyui.reverseGate
    if (b.comfyui?.url !== undefined) {
      if (typeof b.comfyui.url !== 'string') return err(c, 400, 'invalid_config_value', 'comfyui.url must be a string: an http(s):// origin, or empty.')
      const u = b.comfyui.url.trim()
      if (u && !/^https?:\/\//i.test(u)) {
        return err(c, 400, 'invalid_config_value', 'comfyui.url must be an http(s):// origin (e.g. http://127.0.0.1:8188).')
      }
      cuUpdates.url = u
    }

    // Gateway intelligence (v0.6.0): auto-swap toggle + keep-N pool size.
    const gwUpdates: { autoSwap?: boolean; keepN?: number } = {}
    if (b.gateway?.autoSwap !== undefined) gwUpdates.autoSwap = !!b.gateway.autoSwap
    if (b.gateway?.keepN !== undefined) {
      const v = coerceBounded('gateway.keepN', b.gateway.keepN)
      if (v === null) return err(c, 400, 'invalid_config_value', CONFIG_BOUNDS['gateway.keepN'].message)
      gwUpdates.keepN = v
    }

    // Build toolchain dirs (ADR-100): absolute folders prepended to PATH for the prereq
    // probe + 1-click build, so a conda-env / custom-path CUDA Toolkit is found. Validate
    // here for a clean 400 (config.validate() would otherwise throw a 500 on update()).
    let toolchainDirs: string[] | undefined
    if (b.build?.toolchainDirs !== undefined) {
      // Each entry is a string too: String() made a nested ['/x'] the path '/x' (see `typed` above).
      if (!Array.isArray(b.build.toolchainDirs) || !b.build.toolchainDirs.every((p: unknown) => typeof p === 'string')) {
        return err(c, 400, 'invalid_config_value', 'build.toolchainDirs must be an array of paths.')
      }
      const dirs = b.build.toolchainDirs.map((p) => String(p).trim()).filter(Boolean)
      for (const dir of dirs) {
        if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(dir)) {
          return err(c, 400, 'invalid_config_value', `build.toolchainDirs: "${dir}" must be an absolute path.`)
        }
      }
      toolchainDirs = dirs
    }

    // AGENTS.md candidate lists (Code's standing-context injection, persona.ts) — the OPPOSITE
    // constraint from toolchainDirs: must be RELATIVE, not absolute. Clean-400 convenience only;
    // persona.ts containment-checks each entry again at read time regardless (see config.ts's
    // CodeConfig doc comment for why route-level validation alone isn't the real boundary).
    const MAX_AGENTS_MD_CANDIDATES = 8
    let agentsMdProjectCandidates: string[] | undefined
    let agentsMdGlobalCandidates: string[] | undefined
    for (const [key, out] of [
      ['agentsMdProjectCandidates', (v: string[]) => { agentsMdProjectCandidates = v }],
      ['agentsMdGlobalCandidates', (v: string[]) => { agentsMdGlobalCandidates = v }],
    ] as const) {
      const raw = b.code?.[key]
      if (raw === undefined) continue
      // Each entry a string as well: String() stored a null or 5 as the filename "null" or "5".
      if (!Array.isArray(raw) || !raw.every((p: unknown) => typeof p === 'string')) return err(c, 400, 'invalid_config_value', `code.${key} must be an array of filenames.`)
      const list = raw.map((p) => String(p).trim()).filter(Boolean)
      if (list.length > MAX_AGENTS_MD_CANDIDATES) return err(c, 400, 'invalid_config_value', `code.${key}: at most ${MAX_AGENTS_MD_CANDIDATES} candidates.`)
      for (const entry of list) {
        if (/^([a-zA-Z]:[\\/]|[\\/])/.test(entry)) {
          return err(c, 400, 'invalid_config_value', `code.${key}: "${entry}" must be a relative filename/path, not absolute.`)
        }
      }
      out(list)
    }

    // Which coding agent new Code sessions launch with (config.ts's CodeConfig doc comment) —
    // clean 400 on garbage rather than silently falling back at read time.
    let defaultAgent: 'turbollm' | 'pi' | 'claude' | 'opencode' | undefined
    if (b.code?.defaultAgent !== undefined) {
      const v = b.code.defaultAgent
      if (v !== 'turbollm' && v !== 'pi' && v !== 'claude' && v !== 'opencode') {
        return err(c, 400, 'invalid_config_value', 'code.defaultAgent must be one of: turbollm, pi, claude, opencode.')
      }
      defaultAgent = v
    }

    // Tool-call approval gate: global per-tool policy map. Validate every value is
    // one of 'ask' | 'allow' | 'deny' so a garbled patch gets a clean 400, not a
    // silently-dropped/garbage config.
    let toolPolicies: Record<string, 'ask' | 'allow' | 'deny'> | undefined
    if (b.toolPolicies !== undefined) {
      if (typeof b.toolPolicies !== 'object' || b.toolPolicies === null || Array.isArray(b.toolPolicies)) {
        return err(c, 400, 'invalid_config_value', 'toolPolicies must be an object mapping tool name to ask, allow, or deny.')
      }
      const validated: Record<string, 'ask' | 'allow' | 'deny'> = {}
      for (const [toolName, v] of Object.entries(b.toolPolicies)) {
        if (v !== 'ask' && v !== 'allow' && v !== 'deny') {
          return err(c, 400, 'invalid_config_value', `toolPolicies.${toolName} must be ask, allow, or deny.`)
        }
        validated[toolName] = v
      }
      toolPolicies = validated
    }
    // How long a chat reply waits for its tool calls' approvals (execute-with-approval.ts). Open to the
    // same callers as idleTtlMinutes, not hostGate'd like toolPolicies: the wait running out runs
    // nothing (the call is answered as not run), so no value of it lets a tool run.
    if (b.chatApprovalWaitMinutes !== undefined && !isChatApprovalWaitMinutes(b.chatApprovalWaitMinutes)) {
      return err(c, 400, 'invalid_config_value', CHAT_APPROVAL_WAIT_MINUTES.message)
    }
    // Data retention (chat/retention.ts): each bounded field checked here, before anything is applied.
    for (const field of ['apiUsageRawDays', 'routineRunsKept'] as const) {
      const v: unknown = b.retention?.[field]
      if (v !== undefined && !isRetentionValue(field, v)) return err(c, 400, 'invalid_config_value', RETENTION_BOUNDS[field].message)
    }

    // Remote-access provider changes only while no tunnel is up. Saved mid-session, the new
    // provider is what the next crash/health restart (or boot) starts — publishing the box
    // through a provider whose exposure was never confirmed — while the UI already labels the
    // still-running old tunnel with it.
    let providerChangeClearsEnabled = false
    if (b.remoteAccess?.provider !== undefined && d.remote) {
      const kind = d.remote.state().kind
      const running = kind === 'starting' || kind === 'connected' || kind === 'reconnecting'
      const enabled = d.store.snapshot().remoteAccess.enabled
      const changed = normalizeProvider(b.remoteAccess.provider) !== d.store.snapshot().remoteAccess.provider
      // `enabled` as well: it stays true through failed / needs-setup / unavailable, and the next
      // boot auto-starts whatever provider is saved. Not in `off`, though, where the UI shows
      // remote access off and lets a provider be picked (its rule is "any state but off"), so a 409
      // there was a dead end. `enabled` can be set in `off`: a Start that raced a Stop from another
      // client, or the moment at boot before the auto-start runs (a config booted with the
      // experimental flag off has it cleared at boot, see clearEnabledWhileFlagOff). The change is
      // taken and clears `enabled`, so nothing starts the new provider unconfirmed: not a later
      // boot, and not this boot's pending start (cli.ts re-checks).
      if (changed && (running || (kind !== 'off' && enabled))) {
        return err(c, 409, 'remote_access_running', 'Turn remote access off before changing its provider.')
      }
      providerChangeClearsEnabled = changed && enabled
    }

    const apply = (cfg: Config): void => {
      Object.assign(cfg.daemon, updates)
      Object.assign(cfg.modelDefaults, mdUpdates)
      Object.assign(cfg.comfyui, cuUpdates)
      Object.assign(cfg.gateway, gwUpdates)
      if (toolchainDirs !== undefined) cfg.build.toolchainDirs = toolchainDirs
      if (agentsMdProjectCandidates !== undefined) cfg.code.agentsMdProjectCandidates = agentsMdProjectCandidates
      if (agentsMdGlobalCandidates !== undefined) cfg.code.agentsMdGlobalCandidates = agentsMdGlobalCandidates
      if (defaultAgent !== undefined) cfg.code.defaultAgent = defaultAgent
      if (toolPolicies !== undefined) cfg.tools.toolPolicies = toolPolicies
      if (b.autoAllowAll !== undefined) cfg.tools.autoAllowAll = !!b.autoAllowAll
      if (b.chatApprovalWaitMinutes !== undefined) cfg.tools.chatApprovalWaitMinutes = b.chatApprovalWaitMinutes
      if (b.autoLoadOnStart !== undefined) cfg.autoLoadOnStart = !!b.autoLoadOnStart
      if (b.showAllEngineModels !== undefined) cfg.showAllEngineModels = !!b.showAllEngineModels
      if (vramHeadroomMb !== undefined) cfg.vramHeadroomMb = vramHeadroomMb
      if (telemetryLevel !== undefined) cfg.telemetry.level = telemetryLevel
      // Cloud Launch deploy-link settings (ADR-153): the RunPod Template ID the user
      // published themselves (deploy/runpod/README.md) — not a secret, just an id.
      if (b.cloudDeploy?.runpodTemplateId !== undefined) {
        cfg.cloudDeploy.runpodTemplateId = String(b.cloudDeploy.runpodTemplateId).trim()
      }
      // Developer request log (issue #211 follow-up): per-field merge, same reasoning as
      // cloudDeploy/experimental just below — a patch toggling only `captureBodies` (the
      // Privacy & telemetry checkbox) must not silently flip `enabled` back to its Object.assign
      // default, and vice versa for a future toggle that touches only `enabled`.
      if (b.requestLog?.enabled !== undefined) cfg.requestLog.enabled = !!b.requestLog.enabled
      if (b.requestLog?.captureBodies !== undefined) cfg.requestLog.captureBodies = !!b.requestLog.captureBodies
      // Data retention: per-field merge, like requestLog just above.
      if (b.retention?.enabled !== undefined) cfg.retention.enabled = b.retention.enabled
      if (b.retention?.apiUsageRawDays !== undefined) cfg.retention.apiUsageRawDays = b.retention.apiUsageRawDays
      if (b.retention?.routineRunsKept !== undefined) cfg.retention.routineRunsKept = b.retention.routineRunsKept
      // Experimental feature flags (2026-07-14, Settings → Experimental): per-field merge, not
      // Object.assign(cfg.daemon, updates) — a patch touching only one flag must not clobber
      // the other back to whatever `updates.experimental` would otherwise silently overwrite it
      // with (same reasoning as cloudDeploy's own per-field handling just above).
      if (b.experimental?.memory !== undefined) cfg.daemon.experimental.memory = !!b.experimental.memory
      if (b.experimental?.cloudDeploy !== undefined) cfg.daemon.experimental.cloudDeploy = !!b.experimental.cloudDeploy
      if (b.experimental?.routines !== undefined) cfg.daemon.experimental.routines = !!b.experimental.routines
      if (b.experimental?.turboLink !== undefined) cfg.daemon.experimental.turboLink = !!b.experimental.turboLink
      if (b.experimental?.remoteAccess !== undefined) cfg.daemon.experimental.remoteAccess = !!b.experimental.remoteAccess
      // Remote access: per-field merge, never Object.assign — a patch setting only the
      // provider must not wipe a stored tunnel token, and vice versa.
      const ra = b.remoteAccess
      if (ra?.provider !== undefined) cfg.remoteAccess.provider = normalizeProvider(ra.provider)
      if (providerChangeClearsEnabled) cfg.remoteAccess.enabled = false // see the provider-change guard above
      if (ra?.ingressPort !== undefined) cfg.remoteAccess.ingressPort = resolveIngressPort(Number(ra.ingressPort), cfg.daemon.port)
      if (ra?.cloudflare?.tunnelToken !== undefined) cfg.remoteAccess.cloudflare.tunnelToken = String(ra.cloudflare.tunnelToken).trim()
      if (ra?.cloudflare?.hostname !== undefined) cfg.remoteAccess.cloudflare.hostname = String(ra.cloudflare.hostname).trim()
      if (ra?.cloudflare?.accessTeamDomain !== undefined) cfg.remoteAccess.cloudflare.accessTeamDomain = String(ra.cloudflare.accessTeamDomain).trim()
      if (ra?.cloudflare?.accessAud !== undefined) cfg.remoteAccess.cloudflare.accessAud = String(ra.cloudflare.accessAud).trim()
      if (ra?.cloudflare?.requireAccess !== undefined) cfg.remoteAccess.cloudflare.requireAccess = !!ra.cloudflare.requireAccess
      if (ra?.ngrok?.authtoken !== undefined) cfg.remoteAccess.ngrok.authtoken = String(ra.ngrok.authtoken).trim()
      if (ra?.ngrok?.domain !== undefined) cfg.remoteAccess.ngrok.domain = String(ra.ngrok.domain).trim()
      if (ra?.tailscale?.port !== undefined) {
        const p = Number(ra.tailscale.port)
        cfg.remoteAccess.tailscale.port = p === 8443 || p === 10000 ? p : 443
      }
      if (ra?.custom?.publicUrl !== undefined) cfg.remoteAccess.custom.publicUrl = String(ra.custom.publicUrl).trim()
      // Only the SHAPE is enforced here (array of strings) — the same posture config.ts's own
      // normalize takes. The actual allow-list check against LINK_CAPABILITIES happens at the
      // point of use (remote/routes.ts's sanitizeTokenGrant, ADR-422), not here.
      if (ra?.tokenGrant?.capabilities !== undefined) {
        cfg.remoteAccess.tokenGrant.capabilities = ra.tokenGrant.capabilities.filter(
          (x): x is string => typeof x === 'string',
        )
      }
      if (ra?.tokenGrant?.models !== undefined) {
        cfg.remoteAccess.tokenGrant.models = ra.tokenGrant.models.filter((x): x is string => typeof x === 'string')
      }
      // HF token (spec 10 §4): write-only. An explicit '' clears it. Never logged.
      if (b.hfToken !== undefined) cfg.hf.token = String(b.hfToken).trim()
      // GitHub token (write-only, same semantics as HF): an explicit '' clears it.
      // Used to raise the rate limit from 60 → 5,000 req/hour for GitHub API calls.
      if (b.ghToken !== undefined) (cfg.gh ??= { token: '' }).token = String(b.ghToken).trim()
      // Search provider config (F-020). All key/URL fields are write-only; '' clears them.
      // `search` is the canonical block; legacy top-level `tavilyApiKey` still works as an alias.
      cfg.tools.search ??= { provider: 'tavily' }
      const s = cfg.tools.search
      if (b.search?.provider === 'tavily' || b.search?.provider === 'kagi' || b.search?.provider === 'searxng') {
        s.provider = b.search.provider
      }
      const trimmed = (v: string): string | undefined => v.trim() || undefined
      if (b.search?.tavilyApiKey !== undefined) s.tavilyApiKey = trimmed(b.search.tavilyApiKey)
      if (b.search?.kagiApiKey !== undefined) s.kagiApiKey = trimmed(b.search.kagiApiKey)
      if (b.search?.searxngUrl !== undefined) s.searxngUrl = trimmed(b.search.searxngUrl)
      // Legacy alias: top-level tavilyApiKey maps onto search.tavilyApiKey + keeps tools.tavily for read.
      if (b.tavilyApiKey !== undefined) {
        const key = String(b.tavilyApiKey).trim()
        cfg.tools.tavily = key ? { apiKey: key } : undefined
        s.tavilyApiKey = key || undefined
      }
    }
    // Some of these settings are credential management or decide who may reach the daemon at
    // all, so they carry hostGate, like /api/v1/keys and every /api/v1/remote/* route.
    // lanAuth alone let three callers that hostGate refuses rewrite them: a keyless Tailscale
    // Serve identity, a verified Cloudflare Access JWT, and any peer on an open LAN (lanBind on,
    // requireApiKey off). They could turn requireApiKey off or lanBind on (rebinding in place),
    // swap the tunnel/ngrok tokens or the Access team/aud (a new team/aud takes effect at once on
    // a running named tunnel, so whoever set it signs their own JWTs from then on, even after
    // requireApiKey is back on), widen the remote token grant, set every tool to allow, put a
    // directory of their own first on the build PATH, replace the stored HF/GitHub/search
    // credentials, or switch on request-body capture to record the host's Code prompts (or
    // switch the request log off). Judged on the outcome rather than on which fields the body
    // names: the change is applied to a copy first, so a Save that echoes lanBind/requireApiKey/
    // port unchanged still works. The served UI's Save sends only the fields edited on the page
    // now, but one in a tab opened before an update still echoes them with every general setting.
    //
    // The refusal's code is api_key_required, not forbidden: the web client opens its key prompt
    // on it (auth-signal.ts). With requireApiKey off nothing 401s, so nothing else asks a browser
    // without a valid stored key for one, and a non-loopback bind's owner is such a browser:
    // Docker with a published port (the owner arrives from the bridge address) after turning
    // the requirement off, in a private window, from another origin, or with a revoked key.
    // `field` names the setting for API clients; the message uses the Settings screen's words.
    if (!hostGate(c, d)) {
      const now = d.store.snapshot()
      const trial = structuredClone(now)
      apply(trial)
      const changed = hostOnlySettingChanged(now, trial)
      if (changed) {
        const message = `Changing ${changed.label} requires a valid API key.`
        return c.json({ error: { code: 'api_key_required', message, field: changed.field } }, 403)
      }
    }

    const before = d.store.snapshot().daemon
    d.store.update(apply)
    // Keep ToolRegistry in sync when tools config changes.
    if (b.tavilyApiKey !== undefined || b.search !== undefined) {
      d.tools?.updateConfig(d.store.snapshot().tools)
      // Rebuild tool definitions so the engine picks up new/changed search providers
      // without requiring a full daemon restart.
      await d.tools?.buildToolDefinitions()
    }
    // Report the consent choice once, ever (ADR-299 Decision 5). This is the
    // ONLY transmission a machine that chose Off ever makes, and the consent
    // copy is written to say exactly that. Fire-and-forget: the settings save
    // must not wait on, or fail because of, a network call. Only when the level
    // actually CHANGED: the Settings screen sent telemetryLevel with every save
    // (a tab opened before an update still does; the current one sends only edited
    // fields), so saving any unrelated field would otherwise spend the once-ever ping on
    // a "choice" the user never made, and a later real opt-out would go unsent.
    if (telemetryLevel !== undefined && telemetryLevel !== prevTelemetryLevel) void sendConsentChoice(d.store.dir(), telemetryLevel)

    const after = d.store.snapshot().daemon
    // "Require an API key" turned on does no rebind, so nothing else ends a stream a keyless
    // open-LAN peer opened while it was off (see endStaleStreams).
    if (after.requireApiKey && !before.requireApiKey) endStaleStreams(d)

    // Experimental → Remote access switched off: from here every /api/v1/remote/* route (Stop
    // included) refuses and the UI hides the section, so a running tunnel would stay public
    // with no way to stop it. Stop it now, as Stop would (spec 30 §8.1: flag off → "the
    // supervisor does not run"). Only a UI/config-managed tunnel (`remoteAccess.enabled`): the
    // ungated `--tunnel` override (cli.ts) leaves that false and keeps running.
    if (before.experimental?.remoteAccess && !after.experimental?.remoteAccess && d.store.snapshot().remoteAccess.enabled) {
      await stopRemoteAccess(d)
    }

    // A LAN-bind or port change re-points the HTTP listener. Rather than a full daemon
    // restart (which unloads the model), do an in-place rebind that keeps everything
    // loaded (spec 08 §2). Schedule it AFTER this response flushes — the rebind drops
    // in-flight connections. A LAN-only change (same port) is seamless for the browser;
    // a port change needs the client to hop to the new port (it reads `rebind` below).
    const lanChanged = after.lanBind !== before.lanBind
    const portChanged = after.port !== before.port
    let rebind: { portChanged: boolean; port: number; lanBind: boolean } | undefined
    if ((lanChanged || portChanged) && d.rebind) {
      const doRebind = d.rebind
      setTimeout(() => doRebind(), 250)
      // The port the listener ends up on: the configured one only when this save changed it —
      // otherwise the rebind keeps the bound port (`--port`/`--addr`, e.g. the Android app's 7000).
      rebind = { portChanged, port: portChanged ? after.port : (d.bindPort ?? after.port), lanBind: after.lanBind }
    }
    return c.json({ ...settingsPayload(d), rebind })
  })
}

/** The first PATCH /api/v1/settings field that `after` changes from `before` and only a caller
 *  passing hostGate may change, with its name as the Settings screen words it, or null.
 *  Everything else (theme, titles, model defaults, the gateway pool, ...) stays open to any
 *  caller lanAuth admits. */
function hostOnlySettingChanged(before: Config, after: Config): { field: string; label: string } | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const fields: [string, string, (c: Config) => unknown][] = [
    ['lanBind', 'LAN access', (c) => c.daemon.lanBind],
    ['requireApiKey', '"Require an API key"', (c) => c.daemon.requireApiKey],
    ['port', 'the port', (c) => c.daemon.port],
    ['experimental.remoteAccess', 'remote access', (c) => c.daemon.experimental.remoteAccess],
    ['remoteAccess', 'remote access', (c) => c.remoteAccess],
    // First on PATH for the prereq probe (GET /api/v1/build/prereqs, ungated) and every build,
    // which run git/cmake/nvcc/the compiler from there: a directory of the caller's own, or a
    // UNC share on Windows (it passes the absolute-path check), is command execution.
    ['build.toolchainDirs', 'the build toolchain folders', (c) => c.build.toolchainDirs],
    ['toolPolicies', 'tool permissions', (c) => c.tools.toolPolicies],
    ['autoAllowAll', '"Auto-allow all"', (c) => c.tools.autoAllowAll],
    // Body capture records Code sessions' and `turbollm launch` agents' full prompts, which only
    // a hostGate caller may read back (REQUEST_BODIES_HOST_ONLY); switching it on from here was
    // the way to start that capture. Turning the log off hides from the owner what was sent.
    ['requestLog.enabled', 'the request log', (c) => c.requestLog.enabled],
    ['requestLog.captureBodies', '"Log prompts and responses"', (c) => c.requestLog.captureBodies],
    // Lower limits (or the sweep switched on) delete gateway usage rows and old routine runs with the
    // chats they made (chat/retention.ts), so only the host chooses them.
    ['retention.enabled', 'data retention', (c) => c.retention.enabled],
    ['retention.apiUsageRawDays', 'data retention', (c) => c.retention.apiUsageRawDays],
    ['retention.routineRunsKept', 'data retention', (c) => c.retention.routineRunsKept],
    ['hfToken', 'the Hugging Face token', (c) => c.hf.token],
    ['ghToken', 'the GitHub token', (c) => c.gh?.token ?? ''],
    // Field by field: the handler creates an empty `search` block on every save.
    ['search.tavilyApiKey', 'the Tavily API key', (c) => [c.tools.search?.tavilyApiKey, c.tools.tavily?.apiKey]],
    ['search.kagiApiKey', 'the Kagi API key', (c) => c.tools.search?.kagiApiKey],
    ['search.searxngUrl', 'the SearXNG URL', (c) => c.tools.search?.searxngUrl],
  ]
  for (const [field, label, get] of fields) if (!same(get(before), get(after))) return { field, label }
  return null
}

/** The UI-exposed settings subset. Telemetry is surfaced as the 3-option enum. */
function settingsPayload(d: Deps) {
  const cfg = d.store.snapshot()
  const lvl = cfg.telemetry.level
  const telemetryLevel = lvl === 'anon' || lvl === 'full' ? lvl : 'off'
  return {
    idleTtlMinutes: cfg.daemon.idleTtlMinutes,
    port: cfg.daemon.port,
    theme: cfg.daemon.theme,
    // Turbo Link (ADR-376): what this box calls itself to a linked peer. Echoed raw —
    // '' means "not set", and link-routes.ts resolves that to the OS hostname at
    // handshake time. Not a secret.
    machineName: cfg.daemon.machineName ?? '',
    autoGenerateTitles: cfg.daemon.autoGenerateTitles,
    autoMemoryEnabled: cfg.daemon.autoMemoryEnabled,
    openBrowserOnStart: cfg.daemon.openBrowserOnStart,
    autoLoadOnStart: cfg.autoLoadOnStart,
    showAllEngineModels: cfg.showAllEngineModels,
    vramHeadroomMb: cfg.vramHeadroomMb,
    lanBind: cfg.daemon.lanBind,
    requireApiKey: cfg.daemon.requireApiKey,
    telemetryLevel,
    modelDefaults: cfg.modelDefaults,
    comfyui: cfg.comfyui,
    gateway: cfg.gateway,
    requestLog: cfg.requestLog,
    retention: cfg.retention,
    // The HF token is write-only over the wire (spec 10 §4): we never echo it back,
    // only whether one is set, so the UI can show "configured" without leaking it.
    hfTokenSet: cfg.hf.token.length > 0,
    // GitHub token is write-only: expose only whether it is set.
    ghTokenSet: (cfg.gh?.token ?? '').length > 0,
    // Tavily API key is write-only: expose only whether it is set (legacy field, kept for compat).
    tavilyKeySet: !!(cfg.tools.search?.tavilyApiKey ?? cfg.tools.tavily?.apiKey),
    // Search provider config (F-020): provider + which credentials are set. Keys are write-only
    // (booleans only); searxngUrl is not a secret so it is echoed for the form to display.
    search: {
      provider: cfg.tools.search?.provider ?? 'tavily',
      tavilyKeySet: !!cfg.tools.search?.tavilyApiKey,
      kagiKeySet: !!cfg.tools.search?.kagiApiKey,
      searxngUrl: cfg.tools.search?.searxngUrl ?? '',
    },
    // apiKey is write-only: strip before echoing so Bearer tokens never reach the frontend.
    // apiKeySet says only whether one is stored, so the edit form can show it and offer a clear.
    // A stdio server's env values are write-only as well: key names only (maskMcpEnv).
    mcp: { ...cfg.mcp, servers: cfg.mcp.servers.map(({ apiKey: k, ...s }) => ({ ...maskMcpEnv(s), apiKeySet: !!k })) },
    // Build environment (ADR-100): folders prepended to PATH for compile-from-source so a
    // conda-env / custom-path CUDA Toolkit + compiler are found. Not secret — echoed back.
    build: { toolchainDirs: cfg.build.toolchainDirs },
    // Code's AGENTS.md-style standing-context candidate lists (config.ts's CodeConfig):
    // not secret — echoed back.
    code: cfg.code,
    // Cloud Launch deploy-link settings (ADR-153): not secret — echoed back.
    cloudDeploy: cfg.cloudDeploy,
    // Experimental feature flags (2026-07-14): not secret — echoed back for Settings →
    // Experimental and for the frontend to decide whether to show the Code entry point at all.
    experimental: cfg.daemon.experimental,
    // Tool-call approval gate: global per-tool policy ('ask' | 'allow' | 'deny').
    // Not secret — echoed back directly so Settings can render Tool Permissions.
    toolPolicies: cfg.tools.toolPolicies ?? {},
    autoAllowAll: cfg.tools.autoAllowAll ?? false,
    chatApprovalWaitMinutes: cfg.tools.chatApprovalWaitMinutes ?? CHAT_APPROVAL_WAIT_MINUTES.default,
    // Remote access (ADR-422). Secrets are WRITE-ONLY: the booleans say whether one is
    // stored, never what it is — same posture as hfToken/ghToken/tavilyApiKey.
    remoteAccess: {
      enabled: cfg.remoteAccess.enabled,
      provider: cfg.remoteAccess.provider,
      ingressPort: cfg.remoteAccess.ingressPort,
      cloudflare: {
        hasTunnelToken: !!cfg.remoteAccess.cloudflare.tunnelToken,
        hostname: cfg.remoteAccess.cloudflare.hostname,
        accessTeamDomain: cfg.remoteAccess.cloudflare.accessTeamDomain,
        accessAud: cfg.remoteAccess.cloudflare.accessAud,
        requireAccess: cfg.remoteAccess.cloudflare.requireAccess,
      },
      ngrok: { hasAuthtoken: !!cfg.remoteAccess.ngrok.authtoken, domain: cfg.remoteAccess.ngrok.domain },
      tailscale: { port: cfg.remoteAccess.tailscale.port },
      custom: { publicUrl: cfg.remoteAccess.custom.publicUrl },
      // Not a secret — a capability list, same posture as toolPolicies above. Echoed as
      // stored; sanitizeTokenGrant (remote/routes.ts) is what actually enforces the
      // LINK_CAPABILITIES allow-list, at the point a token is minted.
      tokenGrant: cfg.remoteAccess.tokenGrant,
      lastUrl: cfg.remoteAccess.lastUrl,
    },
  }
}
