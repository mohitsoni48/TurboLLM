import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, Globe, Loader2, Minus, RefreshCw } from 'lucide-react'
import {
  getRemoteStatus,
  preflightRemote,
  startRemote,
  stopRemote,
  type RemoteProviderId,
  type RemoteState,
  type RemoteStatus,
} from '../../lib/remote-api'
import { ApiError, track } from '../../lib/api'
import { useSettings } from '../../lib/queries'
import { PROVIDER_CARDS } from './remote-provider-cards'
import { Switch } from '../../components/ui/switch'
import { Button } from '../../components/ui/button'
import { CopyButton } from '../../components/ui/copy-button'
import { toast } from '../../components/ui/sonner'

const PROVIDER_IDS = Object.keys(PROVIDER_CARDS) as RemoteProviderId[]
const TAILSCALE_PORTS = [443, 8443, 10000] as const

/** Settings → Network & sharing's Remote access story (spec 30 §7, ADR-422): provider cards
 *  with real costs stated up front (engines-catalog convention — pros/cons only, no prose),
 *  a preflight check that renders each provider's OWN reason rather than a generic red X, and
 *  the on/off switch that starts or stops the tunnel in place — no daemon restart, no model
 *  unload. The exposure-confirmation dialog for publicly reachable providers is Task 16, not
 *  built here — this switch calls startRemote()/stopRemote() directly. */
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

  useEffect(() => {
    const ra = settingsQ.data?.remoteAccess
    if (!ra || seeded) return
    setProvider(ra.provider)
    setCfHostname(ra.cloudflare?.hostname ?? '')
    setNgrokDomain(ra.ngrok?.domain ?? '')
    setTsPort(ra.tailscale?.port ?? 443)
    setCustomUrl(ra.custom?.publicUrl ?? '')
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
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the provider.') },
    )
    runPreflight(p)
  }

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

  const enabled = !!status?.enabled && status.state.kind !== 'off'

  const onToggle = (checked: boolean) => {
    setToggling(true)
    track('settings', checked ? 'start_remote' : 'stop_remote')
    const action = checked ? startRemote() : stopRemote()
    void action
      .then(() => statusQ.refetch())
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not update remote access.'))
      .finally(() => setToggling(false))
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-1 flex items-center gap-2">
          <Globe size={15} className="text-accent" />
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Remote access</h2>
        </div>
        <p className="mb-3 text-[12px] text-muted">
          Reach this machine's chat from somewhere else. Each option's real cost is stated on its
          card, before you turn it on.
        </p>

        <div role="radiogroup" aria-label="Remote access provider" className="flex flex-col gap-2">
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
                className="rounded-md border p-3"
                style={{ borderColor: selected ? 'var(--accent)' : 'var(--border)' }}
              >
                <button type="button" role="radio" aria-checked={selected} aria-label={card.title} onClick={() => selectProvider(id)} className="w-full text-left">
                  <div className="text-[13px] font-medium text-ink">{card.title}</div>
                  <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
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
                </button>

                {selected && checking && !reason && (
                  <div className="mt-3 flex items-center gap-1.5 text-[12px] text-faint">
                    <Loader2 size={12} className="animate-spin" /> Checking…
                  </div>
                )}

                {selected && reason && (
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

                {selected && id === 'cloudflare-named' && (
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

                {selected && id === 'ngrok' && (
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

                {selected && (id === 'tailscale-serve' || id === 'tailscale-funnel') && (
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

                {selected && id === 'custom' && (
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
            )
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-ink">Remote access</div>
            <div className="text-[11px] text-faint">{enabled ? 'On — reachable through this provider.' : 'Off.'}</div>
          </div>
          <Switch aria-label="Remote access" checked={enabled} onCheckedChange={onToggle} disabled={toggling} />
        </div>
        <div className="mt-3">
          <LiveStateBlock status={status} onRetry={() => onToggle(true)} />
        </div>
      </div>
    </section>
  )
}

/** connected → URL + Copy; reconnecting → the word itself, attempt number, lastError; failed →
 *  reason + Retry; starting → spinner. Colors from tokens only (spec 30 §11). */
function LiveStateBlock({ status, onRetry }: { status: RemoteStatus | undefined; onRetry: () => void }) {
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
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    )
  }

  return null
}
