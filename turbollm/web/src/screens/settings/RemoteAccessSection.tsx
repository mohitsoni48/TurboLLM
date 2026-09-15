import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, Globe, Loader2, Minus, RefreshCw } from 'lucide-react'
import {
  getRemoteStatus,
  isPublicProvider,
  preflightRemote,
  startRemote,
  stopRemote,
  type RemoteProviderId,
  type RemoteState,
  type RemoteStatus,
} from '../../lib/remote-api'
import { ApiError, track } from '../../lib/api'
import { useSettings } from '../../lib/queries'
import { LINK_PRESETS, type LinkCapability } from '../../lib/link-constants'
import { PROVIDER_CARDS } from './remote-provider-cards'
import { ExposureConfirmDialog } from './ExposureConfirmDialog'
import { Switch } from '../../components/ui/switch'
import { Button } from '../../components/ui/button'
import { CopyButton } from '../../components/ui/copy-button'
import { toast } from '../../components/ui/sonner'

const PROVIDER_IDS = Object.keys(PROVIDER_CARDS) as RemoteProviderId[]
const TAILSCALE_PORTS = [443, 8443, 10000] as const

/** The capabilities offered to a remote-access token, deliberately narrower than Turbo
 *  Link's own "Full control" preset: this token rides along a URL a user hands to their OWN
 *  other devices, not a peer machine, so downloads and config capabilities (multi-gigabyte
 *  writes, this machine's own local-use defaults) stay off the picker entirely rather than
 *  one click away. */
const REMOTE_TOKEN_CAPABILITIES = LINK_PRESETS.server

/** Settings → Network & sharing's Remote access story (spec 30 §7, ADR-422): provider cards
 *  with real costs stated up front (engines-catalog convention — pros/cons only, no prose),
 *  a preflight check that renders each provider's OWN reason rather than a generic red X, and
 *  the on/off switch that starts or stops the tunnel in place — no daemon restart, no model
 *  unload. Turning it on for a publicly reachable provider raises Task 16's
 *  {@link ExposureConfirmDialog} first; turning it off, or turning on a tailnet-only provider
 *  like Tailscale Serve, calls startRemote()/stopRemote() directly with no dialog at all. */
export function RemoteAccessSection() {
  const { query: settingsQ, save } = useSettings()
  // Not `useRemoteStatus` (remote-api.ts's own export): that hook's internal call to
  // `getRemoteStatus` is a same-module reference, which a `vi.mock('../../lib/remote-api', ...)`
  // override in this component's OWN test cannot intercept — only cross-module calls (an
  // import into this file) go through the mock. Same queryKey/interval as `useRemoteStatus`
  // so the pane and (later) the shell chip still share one cached poll.
  const statusQ = useQuery({
    queryKey: ['remote-status'],
    queryFn: getRemoteStatus,
    refetchInterval: 6_000,
    retry: false,
  })
  const status = statusQ.data

  const [provider, setProvider] = useState<RemoteProviderId>('cloudflare-quick')
  const [preflight, setPreflight] = useState<{ provider: RemoteProviderId; state: RemoteState } | null>(null)
  const [preflightingFor, setPreflightingFor] = useState<RemoteProviderId | null>(null)
  const [toggling, setToggling] = useState(false)
  // Set when the switch is flipped on for a publicly reachable provider, to hold
  // ExposureConfirmDialog open until the user actually confirms (Task 16, spec 30 §7.2).
  const [pendingEnable, setPendingEnable] = useState(false)

  // Per-provider field drafts, seeded once from settings then locally edited. Secrets
  // (cfToken/ngrokToken) start blank — they are write-only, never echoed back (same posture
  // as hfToken/ghToken) — so blank on save means "keep what's stored", never "clear it".
  const [seeded, setSeeded] = useState(false)
  const [cfToken, setCfToken] = useState('')
  const [cfHostname, setCfHostname] = useState('')
  const [ngrokToken, setNgrokToken] = useState('')
  const [ngrokDomain, setNgrokDomain] = useState('')
  const [tsPort, setTsPort] = useState<number>(443)
  const [customUrl, setCustomUrl] = useState('')

  // The capability set a newly-minted remote token receives (ADR-422 §6.3), and the raw
  // token value itself — held ONLY in memory, for exactly as long as this component stays
  // mounted after a successful start, since the store never keeps anything but its hash.
  const [tokenCaps, setTokenCaps] = useState<Set<LinkCapability>>(new Set(LINK_PRESETS.inference))
  const [revealedToken, setRevealedToken] = useState<string | null>(null)

  useEffect(() => {
    const ra = settingsQ.data?.remoteAccess
    if (!ra || seeded) return
    setProvider(ra.provider)
    setCfHostname(ra.cloudflare?.hostname ?? '')
    setNgrokDomain(ra.ngrok?.domain ?? '')
    setTsPort(ra.tailscale?.port ?? 443)
    setCustomUrl(ra.custom?.publicUrl ?? '')
    setTokenCaps(new Set((ra.tokenGrant?.capabilities ?? LINK_PRESETS.inference) as LinkCapability[]))
    setSeeded(true)
  }, [settingsQ.data, seeded])

  const runPreflight = (p: RemoteProviderId) => {
    setPreflightingFor(p)
    void preflightRemote(p)
      .then((result) => setPreflight(result))
      .catch((e) =>
        setPreflight({
          provider: p,
          state: { kind: 'unavailable', reason: e instanceof ApiError ? e.message : 'Could not check this provider.' },
        }),
      )
      .finally(() => setPreflightingFor((cur) => (cur === p ? null : cur)))
  }

  const selectProvider = (p: RemoteProviderId) => {
    if (p === provider) return
    setProvider(p)
    setPreflight(null)
    track('settings', 'select_remote_provider')
    save.mutate(
      { remoteAccess: { provider: p } },
      {
        // C-new-1 (final-review-fix-rereview.md): the polled ['remote-status'] cache is not
        // invalidated by a settings save, so it can lag the server's now-current provider by
        // up to the 6s refetch interval — exactly the window `effectiveProvider` below still
        // has to tolerate. Refetching status the moment the save actually lands closes that
        // window down to a single round trip instead of leaving it open for the full 6s.
        onSuccess: () => void statusQ.refetch(),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the provider.'),
      },
    )
    // Preflighting happens in the effect below, keyed on `provider` — not here — so a
    // provider change preflights exactly once (C2, final-review.md).
  }

  // C2 (final-review.md): preflight the SELECTED provider as soon as it is known — once on
  // mount (after settings seed it) and again on every provider change — so "Check again" is
  // reachable for the provider the user already had saved, not only for one they just
  // clicked. Previously only selectProvider() preflighted, and it early-returned when
  // reselecting the same id, so the seeded provider was never checked until the user picked
  // something else and picked it back.
  useEffect(() => {
    if (!seeded) return
    runPreflight(provider)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded, provider])

  const saveCloudflare = () => {
    const patch: { tunnelToken?: string; hostname?: string } = { hostname: cfHostname.trim() }
    if (cfToken.trim()) patch.tunnelToken = cfToken.trim()
    track('settings', 'save_remote_cloudflare')
    save.mutate(
      { remoteAccess: { cloudflare: patch } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the Cloudflare settings.') },
    )
    setCfToken('')
  }

  const saveNgrok = () => {
    const patch: { authtoken?: string; domain?: string } = { domain: ngrokDomain.trim() }
    if (ngrokToken.trim()) patch.authtoken = ngrokToken.trim()
    track('settings', 'save_remote_ngrok')
    save.mutate(
      { remoteAccess: { ngrok: patch } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the ngrok settings.') },
    )
    setNgrokToken('')
  }

  const saveTailscalePort = (port: number) => {
    setTsPort(port)
    track('settings', 'save_remote_tailscale_port')
    save.mutate(
      { remoteAccess: { tailscale: { port } } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the Tailscale port.') },
    )
  }

  const saveCustomUrl = () => {
    track('settings', 'save_remote_custom_url')
    save.mutate(
      { remoteAccess: { custom: { publicUrl: customUrl.trim() } } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the public URL.') },
    )
  }

  // Applies to the NEXT token minted (on the next start) — this does not touch a token
  // already handed out, which the daemon has no way to reach into a browser and revise.
  const toggleTokenCap = (cap: LinkCapability, checked: boolean) => {
    const next = new Set(tokenCaps)
    if (checked) next.add(cap)
    else next.delete(cap)
    // Never persist an empty set: sanitizeTokenGrant (turbollm/src/remote/routes.ts) falls
    // back to models:use server-side anyway, so an empty picker would silently diverge from
    // what the next token actually gets.
    const caps = next.size ? Array.from(next) : (['models:use'] as LinkCapability[])
    setTokenCaps(new Set(caps))
    track('settings', 'save_remote_token_grant')
    save.mutate(
      { remoteAccess: { tokenGrant: { capabilities: caps } } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the token permissions.') },
    )
  }

  // I1/C1 (final-review.md): "on" must be read off the live runtime state, not the
  // desired-config `status.enabled` flag — those two disagree during a stop's up-to-8s
  // shutdown window (and permanently for needs-setup/unavailable), which is exactly the case
  // RemoteChip.tsx already gets right. Matching it here means the pane and the chip never
  // disagree about whether remote access is actually on.
  const isOn = !!status && status.state.kind !== 'off'

  // C3 (final-review.md): /remote/start acts on the daemon's persisted provider, not this
  // component's local draft — a failed or in-flight provider-change PATCH can leave the two
  // disagreeing (bypass (b)). `status?.provider` is the best available signal for what the
  // server currently holds once a status poll has resolved.
  const effectiveProvider = status?.provider ?? provider

  // C-new-1 (final-review-fix-rereview.md): gating on `effectiveProvider` ALONE re-opened a
  // WIDER bypass than the one C3 closed — `['remote-status']` is polled on its own 6s
  // schedule, untied to the settings save above, so for up to that long after a completely
  // ordinary, successful provider change the poll still reports the OLD provider. Gating
  // needs to be false-SAFE: require confirmation if EITHER the local draft (what the user
  // just picked, and what a just-completed save has very likely already persisted
  // server-side) OR the last-polled server value is public. This can only ever show the
  // dialog MORE often than strictly necessary, never skip it when either signal says public.
  const needsExposureConfirm = isPublicProvider(provider) || isPublicProvider(effectiveProvider)

  // I-new-1 (final-review-fix-rereview.md): the dialog must name the provider that's actually
  // responsible for the warning, not always whichever of the two happens to be server truth —
  // showing "ngrok will publish this daemon" while the user has Tailscale Serve selected (or
  // vice versa) is a false claim in whichever direction it's wrong. The common case is that
  // the local draft IS the public one (matches the radio highlight, matches what a completed
  // save has already persisted) — fall back to the server value only when the local draft
  // ITSELF isn't the one that tripped the gate, i.e. a stale-server disagreement.
  const dialogProvider = isPublicProvider(provider) ? provider : effectiveProvider

  // M-new-1 (final-review-fix-rereview.md): `needsExposureConfirm` is re-derived from a
  // POLLED value every render, so it can in principle turn false while the dialog is still
  // open (the disagreement that made it true in the first place resolves mid-interaction) —
  // without this, `pendingEnable` would stay stuck `true` with nothing rendering to clear it.
  useEffect(() => {
    if (pendingEnable && !needsExposureConfirm) setPendingEnable(false)
  }, [pendingEnable, needsExposureConfirm])

  // Shared by the direct-start path (non-public provider, or Retry below) and the
  // confirmed-start path (public provider, after ExposureConfirmDialog's onConfirm) — same
  // tracking event, refetch and error handling either way.
  const doStart = () => {
    setToggling(true)
    setRevealedToken(null)
    track('settings', 'start_remote')
    void startRemote()
      .then((res) => {
        // Present exactly once per successful start (ADR-422 §6.3) — the store keeps only a
        // hash, so this response is the only moment the raw value exists in readable form.
        if (res.token) setRevealedToken(res.token)
        return statusQ.refetch()
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not update remote access.'))
      .finally(() => setToggling(false))
  }

  const onToggle = (checked: boolean) => {
    if (!checked) {
      setToggling(true)
      // The token this stop is about to revoke is no longer any good — leaving it on screen
      // would show a value that looks copyable but has already stopped working.
      setRevealedToken(null)
      track('settings', 'stop_remote')
      void stopRemote()
        .then(() => statusQ.refetch())
        .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not update remote access.'))
        .finally(() => setToggling(false))
      return
    }
    // Publicly reachable provider: hold off starting until ExposureConfirmDialog's onConfirm.
    // Tailscale Serve (and any other non-public provider) is tailnet-only, so the dialog would
    // render null anyway — start directly with no confirmation, per Task 15's existing test.
    if (needsExposureConfirm) {
      setPendingEnable(true)
      return
    }
    doStart()
  }

  return (
    <section className="flex flex-col gap-4">
      {/* Primary card: the actual on/off control. This used to sit at the bottom of the
          section, below the full provider list and the token-permissions checkboxes — easy to
          miss on a page that scrolls, and disconnected from the heading that names it. It is
          now the first thing this section renders, so it never depends on how far the reader
          has scrolled. */}
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-1 flex items-center gap-2">
          <Globe size={15} className="text-accent" />
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Remote access</h2>
        </div>
        <p className="mb-3 text-[12px] text-muted">
          Reach this machine's chat from somewhere else. Each option's real cost is stated below,
          before you turn it on.
        </p>

        {/* I3 (final-review.md): a refused or unreachable status request must not render
            identically to "off" — show it. */}
        {statusQ.isError && (
          <div
            className="mb-3 flex items-center gap-1.5 rounded-md border p-2 text-[12px]"
            style={{
              borderColor: 'color-mix(in srgb, var(--err) 40%, var(--border))',
              background: 'color-mix(in srgb, var(--err) 8%, transparent)',
              color: 'var(--err)',
            }}
          >
            <AlertTriangle size={13} />
            {statusQ.error instanceof ApiError ? statusQ.error.message : 'Could not reach remote access status.'}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg p-3">
          <div>
            <div className="text-[13px] font-medium text-ink">{PROVIDER_CARDS[provider].title}</div>
            {/* Generic on/off state text — LiveStateBlock below carries every state-specific
                detail (including WHY it isn't reachable), so this line no longer claims
                "reachable" for a state that might be starting, reconnecting, failed,
                needs-setup, or unavailable (C1, final-review.md). */}
            <div className="text-[11px] text-faint">{isOn ? 'On.' : 'Off.'}</div>
          </div>
          <Switch aria-label="Remote access" checked={isOn} onCheckedChange={onToggle} disabled={toggling} />
        </div>

        <div className="mt-3">
          {/* C3 bypass (a) (final-review.md) / I-new-2 (final-review-fix-rereview.md): both
              Retry (failed) and Check again (needs-setup/unavailable) call the SAME
              onToggle(true) — a locally-scoped preflight() call updates nothing server-side
              (the manager only re-evaluates preflight at its own enable()/disable(), so a
              "clean" client-side recheck previously left the daemon parked exactly where it
              was, with a button that visibly did nothing). Re-attempting the real start is the
              only action that can actually un-stick it, and it also means Check again can
              never assume stale consent still applies any more than Retry can. */}
          <LiveStateBlock status={status} onRetry={() => onToggle(true)} toggling={toggling} />
        </div>

        {revealedToken && (
          <div
            className="mt-3 rounded-md border p-3"
            style={{ borderColor: 'color-mix(in srgb, var(--accent) 40%, var(--border))', background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
          >
            <div className="mb-1.5 text-[12px] font-medium text-ink">Access token</div>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate font-mono text-[12px] text-ink">{revealedToken}</span>
              <CopyButton text={revealedToken} screen="settings" />
            </div>
            <p className="mt-2 text-[11px] text-faint">
              Shown once — it cannot be recovered. Manage or revoke it in Developer → API Keys.
            </p>
          </div>
        )}
      </div>

      {/* Provider picker: compact single-line rows. Pros/Cons and provider-specific fields used
          to render for all six options at once, all the time — a long scroll of duplicated
          detail. Only the selected row now expands, so choosing a provider looks like a normal
          settings list instead of an unfiltered spec dump. */}
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Provider</div>
        <div role="radiogroup" aria-label="Remote access provider" className="flex flex-col gap-1.5">
          {PROVIDER_IDS.map((id) => {
            const card = PROVIDER_CARDS[id]
            const selected = provider === id
            const checking = preflightingFor === id
            const reason =
              preflight?.provider === id && (preflight.state.kind === 'unavailable' || preflight.state.kind === 'needs-setup')
                ? preflight.state.reason
                : null

            return (
              <div
                key={id}
                className="rounded-md border"
                style={{
                  borderColor: selected ? 'var(--accent)' : 'var(--border)',
                  background: selected ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : 'transparent',
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={card.title}
                  onClick={() => selectProvider(id)}
                  className="flex w-full items-center gap-2.5 p-2.5 text-left"
                >
                  <span
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border"
                    style={{ borderColor: selected ? 'var(--accent)' : 'var(--border-strong)' }}
                  >
                    {selected && <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">{card.title}</span>
                    <span className="block truncate text-[11px] text-faint">{card.summary}</span>
                  </span>
                </button>

                {selected && (
                  <div className="border-t border-border px-3 pb-3 pt-2.5">
                    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                      <div>
                        <div className="text-[11px] font-semibold" style={{ color: 'var(--ok)' }}>Pros</div>
                        <ul className="mt-1 flex flex-col gap-1">
                          {card.pros.map((p, i) => (
                            <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-ink">
                              <Check size={12} className="mt-px shrink-0" style={{ color: 'var(--ok)' }} />
                              <span>{p}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="text-[11px] font-semibold" style={{ color: 'var(--warn)' }}>Cons</div>
                        <ul className="mt-1 flex flex-col gap-1">
                          {card.cons.map((c, i) => (
                            <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-ink">
                              <Minus size={12} className="mt-px shrink-0" style={{ color: 'var(--warn)' }} />
                              <span>{c}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    {checking && !reason && (
                      <div className="mt-3 flex items-center gap-1.5 text-[12px] text-faint">
                        <Loader2 size={12} className="animate-spin" /> Checking…
                      </div>
                    )}

                    {reason && (
                      <div
                        className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                        style={{ borderColor: 'color-mix(in srgb, var(--err) 40%, var(--border))', background: 'color-mix(in srgb, var(--err) 8%, transparent)' }}
                      >
                        <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--err)' }}>
                          <AlertTriangle size={13} /> {reason}
                        </span>
                        <Button size="sm" variant="outline" onClick={() => runPreflight(id)} disabled={checking}>
                          {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                          Check again
                        </Button>
                      </div>
                    )}

                    {id === 'cloudflare-named' && (
                      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
                        <label className="text-[12px] text-muted" htmlFor="remote-cf-token">Tunnel token</label>
                        <input
                          id="remote-cf-token"
                          type="password"
                          value={cfToken}
                          onChange={(e) => setCfToken(e.target.value)}
                          placeholder={settingsQ.data?.remoteAccess?.cloudflare?.hasTunnelToken ? 'Stored — leave blank to keep' : 'Paste the token from the Cloudflare dashboard'}
                          spellCheck={false}
                          autoComplete="off"
                          className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
                        />
                        <label className="text-[12px] text-muted" htmlFor="remote-cf-hostname">Hostname</label>
                        <input
                          id="remote-cf-hostname"
                          type="text"
                          value={cfHostname}
                          onChange={(e) => setCfHostname(e.target.value)}
                          placeholder="llm.example.com"
                          spellCheck={false}
                          autoComplete="off"
                          className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
                        />
                        <div><Button size="sm" variant="outline" onClick={saveCloudflare} disabled={save.isPending}>Save</Button></div>
                      </div>
                    )}

                    {id === 'ngrok' && (
                      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
                        <label className="text-[12px] text-muted" htmlFor="remote-ngrok-token">Authtoken</label>
                        <input
                          id="remote-ngrok-token"
                          type="password"
                          value={ngrokToken}
                          onChange={(e) => setNgrokToken(e.target.value)}
                          placeholder={settingsQ.data?.remoteAccess?.ngrok?.hasAuthtoken ? 'Stored — leave blank to keep' : 'Paste your ngrok authtoken'}
                          spellCheck={false}
                          autoComplete="off"
                          className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
                        />
                        <label className="text-[12px] text-muted" htmlFor="remote-ngrok-domain">Reserved domain (optional)</label>
                        <input
                          id="remote-ngrok-domain"
                          type="text"
                          value={ngrokDomain}
                          onChange={(e) => setNgrokDomain(e.target.value)}
                          placeholder="Leave blank for a random ngrok URL"
                          spellCheck={false}
                          autoComplete="off"
                          className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
                        />
                        <div><Button size="sm" variant="outline" onClick={saveNgrok} disabled={save.isPending}>Save</Button></div>
                      </div>
                    )}

                    {(id === 'tailscale-serve' || id === 'tailscale-funnel') && (
                      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                        <label className="text-[12px] text-muted" htmlFor="remote-ts-port">Port</label>
                        <select
                          id="remote-ts-port"
                          value={tsPort}
                          onChange={(e) => saveTailscalePort(Number(e.target.value))}
                          className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
                        >
                          {TAILSCALE_PORTS.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </div>
                    )}

                    {id === 'custom' && (
                      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
                        <label className="text-[12px] text-muted" htmlFor="remote-custom-url">Public URL</label>
                        <input
                          id="remote-custom-url"
                          type="text"
                          value={customUrl}
                          onChange={(e) => setCustomUrl(e.target.value)}
                          placeholder="https://llm.example.com"
                          spellCheck={false}
                          autoComplete="off"
                          className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
                        />
                        <div><Button size="sm" variant="outline" onClick={saveCustomUrl} disabled={save.isPending}>Save</Button></div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-[12px] font-medium text-ink">Token permissions</div>
          <p className="text-[11px] text-faint">
            What the access token minted the next time you turn this on is allowed to do.
          </p>
          <p className="text-[11px] text-faint">
            A scoped token can chat and manage conversations; it cannot see full engine/model
            status detail or change settings.
          </p>
          <div className="mt-1 flex flex-col gap-1">
            {REMOTE_TOKEN_CAPABILITIES.map((cap) => (
              <label key={cap} className="flex items-center gap-2 text-[12px] text-ink">
                <input
                  type="checkbox"
                  checked={tokenCaps.has(cap)}
                  onChange={(e) => toggleTokenCap(cap, e.target.checked)}
                />
                <span className="font-mono">{cap}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <ExposureConfirmDialog
        provider={dialogProvider}
        open={pendingEnable}
        onConfirm={() => {
          setPendingEnable(false)
          doStart()
        }}
        onCancel={() => setPendingEnable(false)}
      />
    </section>
  )
}

/** connected → URL + Copy; reconnecting → the word itself, attempt number, lastError; failed →
 *  reason + Retry; needs-setup/unavailable → reason + Check again (C1, final-review.md — this
 *  used to fall through to `return null`, leaving the reason nowhere on screen); starting →
 *  spinner. Colors from tokens only (spec 30 §11). */
function LiveStateBlock({
  status,
  onRetry,
  toggling,
}: {
  status: RemoteStatus | undefined
  onRetry: () => void
  toggling: boolean
}) {
  if (!status) return null
  const { state } = status
  if (state.kind === 'off') return null

  if (state.kind === 'starting') {
    return (
      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--warn)' }}>
        <Loader2 size={13} className="animate-spin" /> Starting…
      </div>
    )
  }

  if (state.kind === 'connected') {
    return (
      <div className="flex items-center gap-2">
        <Check size={13} style={{ color: 'var(--ok)' }} />
        <span className="flex-1 truncate font-mono text-[12px] text-ink">{state.url}</span>
        <CopyButton text={state.url} screen="settings" />
      </div>
    )
  }

  if (state.kind === 'reconnecting') {
    return (
      <div className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--warn)' }}>
          <Loader2 size={13} className="animate-spin" /> Reconnecting (attempt {state.attempt})
        </span>
        <span className="text-[11px] text-faint">{state.lastError}</span>
      </div>
    )
  }

  if (state.kind === 'failed') {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px]" style={{ color: 'var(--err)' }}>{state.reason}</span>
        <Button size="sm" variant="outline" onClick={onRetry} disabled={toggling}>Retry</Button>
      </div>
    )
  }

  if (state.kind === 'needs-setup' || state.kind === 'unavailable') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--err)' }}>
          <AlertTriangle size={13} /> {state.reason}
        </span>
        {/* I-new-2 (final-review-fix-rereview.md): calls the SAME onRetry as the failed
            branch above — a locally-scoped preflight() re-check updates nothing server-side
            (the manager only re-evaluates at its own enable()/disable()), so the only action
            that can actually un-stick a fixed prerequisite is re-attempting the real start. */}
        <Button size="sm" variant="outline" onClick={onRetry} disabled={toggling}>
          {toggling ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Check again
        </Button>
      </div>
    )
  }

  return null
}
