import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ChevronRight, Cloud, ExternalLink, Globe, Key, Plus, Rocket, ShieldCheck, Terminal, Trash2 } from 'lucide-react'
import { CopyButton } from '../components/ui/copy-button'
import { ScreenHeader } from '../components/common'
import { Button } from '../components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { useApiKeys, useSettings, useStatus } from '../lib/queries'
import { ApiError, getConnect, type ConnectInfo, type ConnectStep, type ToolPolicy } from '../lib/api'
import { fetchAvailableTools } from '../lib/chat-api'
import { friendlyName } from './chat/MessageBubble'
import { toast } from '../components/ui/sonner'
import { cn } from '../lib/utils'

const BASE = window.location.origin

const PUBLIC_APIS = [
  { method: 'POST', path: '/v1/chat/completions', desc: 'OpenAI Chat Completions' },
  { method: 'POST', path: '/v1/messages',          desc: 'Anthropic Messages' },
  { method: 'GET',  path: '/v1/models',             desc: 'OpenAI Models List' },
  { method: 'GET',  path: '/api/v1/status',         desc: 'Daemon Status' },
  { method: 'GET',  path: '/api/v1/engines',        desc: 'Engine Registry' },
  { method: 'GET',  path: '/api/v1/models',         desc: 'Model Library' },
  { method: 'GET',  path: '/api/v1/keys',           desc: 'API Keys' },
] as const

const CLI_LIST = [
  { id: 'claude-code', name: 'Claude Code', desc: 'Anthropic-compatible endpoint — the hero demo' },
  { id: 'opencode',    name: 'opencode',    desc: 'OpenAI-compatible, AI SDK provider config' },
  { id: 'kilo',        name: 'Kilo Code',   desc: 'OpenAI-compatible, kilo.jsonc provider entry' },
  { id: 'qwen',        name: 'Qwen Code',   desc: 'OpenAI-compatible (OPENAI_BASE_URL)' },
]

export function DeveloperScreen() {
  const { data: status } = useStatus()
  // Cloud Deploy is behind a local, undocumented feature flag (TURBOLLM_FEATURES=
  // cloud-deploy) while the RunPod side of it is paused — the tunnel/backend work
  // is finished and stays shipped, but there's no official RunPod Template yet, so
  // the button isn't ready for normal users. See turbollm/src/features.ts.
  const cloudDeployEnabled = !!status?.features?.includes('cloud-deploy')

  return (
    <div className="w-full px-6 py-6">
      <ScreenHeader title="Developer" description="Server URLs, API endpoints, keys, and CLI setup." />
      <div className="flex flex-col gap-6">
        <ServerSection />
        {cloudDeployEnabled && <CloudDeploySection />}
        <ApiKeysSection />
        <ToolPermissionsSection />
        <ApisSection />
        <ConnectSection />
      </div>
    </div>
  )
}

// ── Server ────────────────────────────────────────────────────────────────────

function ServerSection() {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Globe size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Server</h2>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-[13px] text-muted">Local URL</span>
        <div className="flex items-center gap-2">
          <code className="font-mono text-[13px] text-ink">{BASE}</code>
          <CopyButton text={BASE} />
        </div>
      </div>
    </section>
  )
}

// ── Cloud Deploy (ADR-153, RunPod recipe) ──────────────────────────────────────

// The official, maintainer-published RunPod Template (built + pushed to GHCR by
// .github/workflows/runpod-image.yml, then turned into ONE public RunPod Template by
// hand — RunPod has no API-less way to automate template creation itself). Empty
// until that one-time setup is done; users are never expected to publish their own —
// the Settings field below is an ADVANCED override for people running a custom fork.
const OFFICIAL_RUNPOD_TEMPLATE_ID = ''

function CloudDeploySection() {
  const { query: settingsQ, save } = useSettings()
  const [templateId, setTemplateId] = useState('')

  // Sync the editable draft from the loaded/saved value (same pattern as the other
  // controlled-input settings fields in SettingsScreen.tsx).
  useEffect(() => {
    if (settingsQ.data) setTemplateId(settingsQ.data.cloudDeploy?.runpodTemplateId ?? '')
  }, [settingsQ.data])

  const savedOverride = (settingsQ.data?.cloudDeploy?.runpodTemplateId ?? '').trim()
  const dirty = templateId.trim() !== savedOverride
  // The override (if the user set one) always wins; otherwise fall back to the
  // official shared template — this is what makes the button work with ZERO setup
  // for a normal user, unlike the earlier design that required everyone to publish
  // their own image/template first.
  const effectiveId = savedOverride || OFFICIAL_RUNPOD_TEMPLATE_ID

  const handleSave = () => {
    save.mutate(
      { cloudDeploy: { runpodTemplateId: templateId.trim() } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the template id.') },
    )
  }

  const deploy = () => {
    if (!effectiveId) return
    window.open(`https://runpod.io/console/deploy?template=${encodeURIComponent(effectiveId)}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Cloud size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Cloud Deploy</h2>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Run TurboLLM on a rented GPU box, reachable over the internet via{' '}
        <code className="font-mono text-[11px] text-ink">--tunnel</code>. RunPod is the only
        provider for now — click below to deploy the official TurboLLM template, no setup
        required. Running a custom fork? Paste your own RunPod Template ID to override it
        (see <code className="font-mono text-[11px] text-ink">deploy/runpod/README.md</code>).
      </p>
      <div className="flex gap-2">
        <input
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          placeholder={OFFICIAL_RUNPOD_TEMPLATE_ID ? 'Custom Template ID (optional — leave blank for the official one)' : 'Custom Template ID (optional)'}
          className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink outline-none placeholder:text-faint focus:border-[color:var(--accent)]"
          onKeyDown={(e) => e.key === 'Enter' && dirty && handleSave()}
        />
        <Button size="sm" variant="outline" onClick={handleSave} disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <Button
        className="mt-3 w-full"
        onClick={deploy}
        disabled={!effectiveId || dirty}
        title={
          !effectiveId
            ? 'No template configured yet'
            : dirty
              ? 'Save your changes first'
              : `Opens RunPod's console in a new tab${savedOverride ? ' (using your custom template)' : ''}`
        }
      >
        <Rocket size={14} />
        Deploy on RunPod
        <ExternalLink size={12} />
      </Button>
    </section>
  )
}

// ── API Keys ──────────────────────────────────────────────────────────────────

function ApiKeysSection() {
  const { query, create, revoke } = useApiKeys()
  const [newName, setNewName] = useState('')
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const keys = query.data?.keys ?? []

  const handleCreate = () => {
    const name = newName.trim()
    if (!name) return
    create.mutate(name, {
      onSuccess: (data) => { setNewName(''); setJustCreated(data.key) },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create key.'),
    })
  }

  const handleRevoke = (id: string, prefix: string) => {
    revoke.mutate(id, {
      onSuccess: () => {
        if (justCreated?.startsWith(prefix)) setJustCreated(null)
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not revoke key.'),
    })
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Key size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">API Keys</h2>
      </div>

      {justCreated && (
        <div
          className="mb-4 rounded-md border p-3"
          style={{ borderColor: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 8%, transparent)' }}
        >
          <p className="mb-1.5 text-[12px] font-medium" style={{ color: 'var(--ok)' }}>
            Key created — copy it now, it won't be shown again.
          </p>
          <div className="flex items-center gap-2 rounded border border-border bg-bg px-2 py-1.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink">{justCreated}</code>
            <CopyButton text={justCreated} />
          </div>
        </div>
      )}

      {keys.length === 0 && !justCreated && (
        <p className="mb-3 text-[13px] text-faint">No API keys yet.</p>
      )}

      {keys.length > 0 && (
        <div className="mb-3 divide-y divide-border rounded-md border border-border">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between px-3 py-2.5">
              <div>
                <span className="text-[13px] font-medium text-ink">{k.name}</span>
                <span className="ml-2 font-mono text-[11px] text-faint">{k.prefix}…</span>
              </div>
              <button
                type="button"
                onClick={() => handleRevoke(k.id, k.prefix)}
                className="rounded p-1 text-faint transition-colors hover:text-err"
                title="Revoke key"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Key name (e.g. claude-code)"
          className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-[color:var(--accent)]"
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
        <Button size="sm" onClick={handleCreate} disabled={!newName.trim() || create.isPending}>
          <Plus size={13} />
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </section>
  )
}

// ── Tool permissions (F-025 approval gate) ───────────────────────────────────

const POLICY_OPTIONS: { value: ToolPolicy; label: string }[] = [
  { value: 'ask',   label: 'Ask' },
  { value: 'allow', label: 'Allow' },
  { value: 'deny',  label: 'Deny' },
]

function ToolPermissionsSection() {
  const [open, setOpen] = useState(false)
  const toolsQ = useQuery({ queryKey: ['available-tools'], queryFn: fetchAvailableTools })
  const { query: settingsQ, save } = useSettings()
  const tools = toolsQ.data ?? []
  const policies = settingsQ.data?.toolPolicies ?? {}

  const setPolicy = (name: string, value: ToolPolicy) => {
    save.mutate(
      { toolPolicies: { ...policies, [name]: value } },
      { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update tool permission.') },
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-panel p-4">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <ChevronRight size={14} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        <ShieldCheck size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Tool permissions</h2>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mb-3 mt-3 text-[12px] text-muted">
          Control whether each tool the model can call runs automatically, is always blocked, or asks
          for your approval in chat each time.
        </p>

        {toolsQ.isLoading && <p className="text-[13px] text-faint">Loading tools…</p>}
        {!toolsQ.isLoading && tools.length === 0 && (
          <p className="text-[13px] text-faint">No tools available.</p>
        )}

        {tools.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {tools.map((t) => {
              const current = policies[t.name] ?? 'ask'
              return (
                <div key={t.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="font-mono text-[13px] font-medium text-ink">{friendlyName(t.name)}</div>
                    {t.description && (
                      <div className="truncate text-[11px] text-faint" title={t.description}>{t.description}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 overflow-hidden rounded-lg border border-border">
                    {POLICY_OPTIONS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setPolicy(t.name, value)}
                        disabled={save.isPending}
                        className="px-3 py-1.5 text-[12px] transition-colors disabled:opacity-60"
                        style={{
                          background: current === value ? 'var(--accent)' : 'transparent',
                          color: current === value ? 'var(--on-accent)' : 'var(--muted)',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ── Available APIs ─────────────────────────────────────────────────────────────

function ApisSection() {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Available APIs</h2>
      <div className="divide-y divide-border rounded-md border border-border">
        {PUBLIC_APIS.map(({ method, path, desc }) => (
          <div key={path} className="flex items-center gap-3 px-3 py-2">
            <span
              className="w-10 shrink-0 rounded px-1 py-0.5 text-center font-mono text-[10px] font-bold uppercase"
              style={{
                background: method === 'GET'
                  ? 'color-mix(in srgb, var(--ok) 15%, transparent)'
                  : 'color-mix(in srgb, var(--accent) 15%, transparent)',
                color: method === 'GET' ? 'var(--ok)' : 'var(--accent)',
              }}
            >
              {method}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{path}</span>
            <span className="hidden shrink-0 text-[11px] text-muted sm:block">{desc}</span>
            <CopyButton text={`${BASE}${path}`} />
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Connect a CLI ─────────────────────────────────────────────────────────────

function ConnectSection() {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Terminal size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Connect a CLI</h2>
      </div>
      <div className="flex flex-col gap-2.5">
        {CLI_LIST.map((cli) => (
          <ConnectCard key={cli.id} cli={cli} />
        ))}
      </div>
    </section>
  )
}

function ConnectCard({ cli }: { cli: { id: string; name: string; desc: string } }) {
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)

  const toggle = () => {
    if (visible) { setVisible(false); return }
    if (info) { setVisible(true); return }
    setLoading(true)
    void getConnect(cli.id)
      .then((data) => { setInfo(data); setVisible(true) })
      .catch(() => toast.error('Could not fetch setup snippets.'))
      .finally(() => setLoading(false))
  }

  return (
    <div className="rounded-md border border-border bg-bg">
      <div className="flex items-center justify-between px-3 py-2.5">
        <div>
          <span className="text-[13px] font-semibold text-ink">{cli.name}</span>
          <span className="ml-2 text-[11px] text-muted">{cli.desc}</span>
        </div>
        <Button size="sm" variant={visible ? 'outline' : 'default'} onClick={toggle} disabled={loading}>
          {loading ? 'Loading…' : visible ? 'Hide' : 'Get setup'}
        </Button>
      </div>
      {visible && info && (
        <div className="flex flex-col gap-2.5 border-t border-border px-3 pb-3 pt-2.5">
          {info.steps.map((step, i) => (
            <SnippetBlock key={i} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}

function SnippetBlock({ step }: { step: ConnectStep }) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-faint">{step.label}</div>
      <div className="relative rounded border border-border bg-panel-2">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all px-3 py-2 pr-10 font-mono text-[12px] leading-relaxed text-ink">
          {step.snippet}
        </pre>
        <CopyButton text={step.snippet} className="absolute right-2 top-2" />
      </div>
    </div>
  )
}

