import { useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, Check, ChevronRight, Loader2, Pencil, Puzzle, Sparkles, Trash2, X } from 'lucide-react'
import { ScreenHeader } from '../components/common'
import { Button } from '../components/ui/button'
import { toast } from '../components/ui/sonner'
import { useMcpMutations, useSettings } from '../lib/queries'
import { ApiError } from '../lib/api'
import type { McpServer, DaemonSettings, DaemonSettingsPatch } from '../lib/api'
import { CLOUD_MCPS, LOCAL_MCPS, CLOUD_CATS, LOCAL_CATS, BUILTIN_SEARCH } from '../lib/mcp-catalog'
import type { CloudEntry, LocalEntry, BuiltinSearchEntry } from '../lib/mcp-catalog'
import { BRAND_ICONS } from '../lib/brand-icons'
import { cn } from '../lib/utils'
import { SkillsLibrary } from './skills/SkillsLibrary'

const CUSTOMIZE_TABS = [
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp',    label: 'MCP Servers', icon: Puzzle },
] as const
type CustomizeTab = (typeof CUSTOMIZE_TABS)[number]['id']

export function CustomizeScreen() {
  const { query: settingsQ } = useSettings()
  const settings = settingsQ.data
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab: CustomizeTab = searchParams.get('tab') === 'mcp' ? 'mcp' : 'skills'
  const setTab = (tab: CustomizeTab) => setSearchParams(tab === 'skills' ? {} : { tab }, { replace: true })

  return (
    <div className="flex w-full flex-col gap-4 px-6 py-6">
      <ScreenHeader
        title="Customize"
        description="Add tools, skills, and external providers the model can call during conversations."
      />

      <div className="inline-flex w-fit rounded-md border border-border p-0.5">
        {CUSTOMIZE_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              'flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] font-medium transition-colors',
              activeTab === id ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink',
            )}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'skills' ? (
        <SkillsLibrary />
      ) : (
        <McpSection
          servers={settings?.mcp?.servers ?? []}
          search={settings?.search ?? { provider: 'tavily', tavilyKeySet: false, kagiKeySet: false, searxngUrl: '' }}
        />
      )}
    </div>
  )
}

// ── MCP Servers ───────────────────────────────────────────────────────────────

type McpFormState = {
  name: string; transport: 'stdio' | 'sse'
  command: string; argsStr: string; envStr: string
  url: string; apiKey: string; enabled: boolean
}

const emptyMcpForm = (): McpFormState => ({
  name: '', transport: 'stdio', command: '', argsStr: '', envStr: '', url: '', apiKey: '', enabled: true,
})

function serverToForm(s: McpServer): McpFormState {
  return {
    name: s.name, transport: s.transport,
    command: s.command ?? '', argsStr: (s.args ?? []).join(', '),
    envStr: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    url: s.url ?? '', apiKey: s.apiKey ?? '', enabled: s.enabled,
  }
}

function formToPayload(f: McpFormState): Omit<McpServer, 'id'> {
  const args = f.argsStr.trim() ? f.argsStr.split(',').map((s) => s.trim()).filter(Boolean) : []
  const env: Record<string, string> = {}
  for (const line of f.envStr.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return {
    name: f.name.trim(), transport: f.transport,
    command: f.transport === 'stdio' ? f.command.trim() || undefined : undefined,
    args: f.transport === 'stdio' && args.length ? args : undefined,
    env: f.transport === 'stdio' && Object.keys(env).length ? env : undefined,
    url: f.transport === 'sse' ? f.url.trim() || undefined : undefined,
    apiKey: f.transport === 'sse' && f.apiKey.trim() ? f.apiKey.trim() : undefined,
    enabled: f.enabled,
  }
}

// ── Brand helpers ─────────────────────────────────────────────────────────────

function initials(name: string): string {
  const parts = name.split(/\s+/)
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase()
}

function nameColor(name: string): string {
  const palette = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#d97706', '#059669', '#0891b2']
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff
  return palette[h % palette.length]
}

// ── Card components ───────────────────────────────────────────────────────────

function BrandCircle({ name, color, iconSlug }: { name: string; color: string; iconSlug?: string }) {
  const icon = iconSlug ? BRAND_ICONS[iconSlug] : undefined
  if (icon) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `#${icon.hex}` }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="#fff" aria-hidden="true">
          <path d={icon.path} />
        </svg>
      </div>
    )
  }
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold text-white"
      style={{ background: color }}>
      {initials(name)}
    </div>
  )
}

function AuthBadge({ auth }: { auth: CloudEntry['auth'] }) {
  const label = auth === 'oauth' ? 'OAuth' : auth === 'key' ? 'API Key' : 'OAuth/Key'
  const bg = auth === 'oauth'
    ? 'color-mix(in srgb, #d97706 18%, transparent)'
    : auth === 'key'
    ? 'color-mix(in srgb, var(--ok) 18%, transparent)'
    : 'color-mix(in srgb, var(--accent) 18%, transparent)'
  const fg = auth === 'oauth' ? '#d97706' : auth === 'key' ? 'var(--ok)' : 'var(--accent)'
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: bg, color: fg }}>
      {label}
    </span>
  )
}

function RuntimeBadge({ uvx }: { uvx?: boolean }) {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={uvx
        ? { background: 'color-mix(in srgb, #7c3aed 18%, transparent)', color: '#7c3aed' }
        : { background: 'color-mix(in srgb, var(--accent) 18%, transparent)', color: 'var(--accent)' }}>
      {uvx ? 'uvx' : 'npx'}
    </span>
  )
}

function McpCard({ entry, tab, isSelected, isConnected, onSelect }: {
  entry: CloudEntry | LocalEntry; tab: 'cloud' | 'local'; isSelected: boolean; isConnected?: boolean; onSelect: () => void
}) {
  const color = tab === 'cloud' ? (entry as CloudEntry).color : nameColor(entry.name)
  return (
    <button type="button" onClick={onSelect}
      className="relative flex flex-col gap-2 rounded-lg border bg-panel-2 p-3 text-left transition-colors hover:bg-bg"
      style={{ borderColor: isSelected ? 'var(--accent)' : isConnected ? 'color-mix(in srgb, var(--ok) 50%, transparent)' : 'var(--border, #e2e2e2)' }}>
      {isConnected && (
        <span className="absolute right-2 top-2 flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold"
          style={{ background: 'color-mix(in srgb, var(--ok) 15%, transparent)', color: 'var(--ok)' }}>
          <Check size={8} /> Connected
        </span>
      )}
      <div className="flex items-start gap-2.5">
        <BrandCircle name={entry.name} color={color} iconSlug={entry.iconSlug} />
        <div className="min-w-0 flex-1 pr-14">
          <div className="truncate text-[13px] font-semibold text-ink">{entry.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-faint">{entry.cat}</span>
            <span className="text-[10px] text-faint">·</span>
            {tab === 'cloud'
              ? <AuthBadge auth={(entry as CloudEntry).auth} />
              : <RuntimeBadge uvx={(entry as LocalEntry).uvx} />}
          </div>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted">{entry.desc}</p>
    </button>
  )
}

function McpCloudPanel({ entry, apiKey, onApiKeyChange, onClose, onConnect, busy }: {
  entry: CloudEntry; apiKey: string; onApiKeyChange: (v: string) => void
  onClose: () => void; onConnect: () => void; busy: boolean
}) {
  const needsKey = entry.auth !== 'oauth'
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border bg-panel-2 p-3"
      style={{ borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrandCircle name={entry.name} color={entry.color} iconSlug={entry.iconSlug} />
          <span className="text-[13px] font-medium text-ink">Connect {entry.name}</span>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-faint transition-colors hover:text-ink">
          <X size={13} />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-muted">Server URL</label>
        <input type="text" value={entry.url} readOnly
          className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-faint outline-none" />
      </div>

      {needsKey ? (
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">API Key / Token</label>
          <input type="password" value={apiKey} onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="Paste your token here" autoComplete="off"
            className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
          {entry.keyNote && <p className="text-[11px] text-faint">{entry.keyNote}</p>}
        </div>
      ) : (
        <p className="rounded-md border border-border bg-bg px-3 py-2 text-[12px] text-muted">
          {entry.name} uses OAuth — add the server and authenticate via the provider developer console.
          {entry.keyNote && <> {entry.keyNote}</>}
        </p>
      )}

      <Button size="sm" onClick={onConnect} disabled={busy || (needsKey && !apiKey.trim())}>
        {busy && <Loader2 size={13} className="animate-spin" />}
        Add server
      </Button>
    </div>
  )
}

function McpLocalPanel({ entry, extraArg, onExtraArgChange, envs, onEnvChange, onClose, onAdd, busy }: {
  entry: LocalEntry; extraArg: string; onExtraArgChange: (v: string) => void
  envs: Record<string, string>; onEnvChange: (k: string, v: string) => void
  onClose: () => void; onAdd: () => void; busy: boolean
}) {
  const canAdd = entry.envs.filter((e) => e.required).every((e) => envs[e.key]?.trim())
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border bg-panel-2 p-3"
      style={{ borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrandCircle name={entry.name} color={nameColor(entry.name)} iconSlug={entry.iconSlug} />
          <span className="text-[13px] font-medium text-ink">Add {entry.name}</span>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-faint transition-colors hover:text-ink">
          <X size={13} />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-muted">Command</label>
        <input type="text" value={entry.cmd} readOnly
          className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-faint outline-none" />
      </div>

      {entry.argNote && (
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">Argument</label>
          <input type="text" value={extraArg} onChange={(e) => onExtraArgChange(e.target.value)}
            placeholder="e.g. /path/to/directory"
            className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
          <p className="text-[11px] text-faint">{entry.argNote}</p>
        </div>
      )}

      {entry.envs.map((ev) => (
        <div key={ev.key} className="flex flex-col gap-1">
          <label className="flex items-center gap-1 text-[12px] text-muted">
            <span className="font-mono">{ev.key}</span>
            {ev.required && <span className="text-[10px]" style={{ color: 'var(--err)' }}>required</span>}
          </label>
          <input type={ev.required ? 'password' : 'text'} value={envs[ev.key] ?? ''}
            onChange={(e) => onEnvChange(ev.key, e.target.value)} placeholder={ev.desc} autoComplete="off"
            className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
        </div>
      ))}

      {entry.uvx && (
        <p className="rounded-md border border-border bg-bg px-3 py-2 text-[11px] text-muted">
          Requires <span className="font-mono text-ink">uv</span> — install with{' '}
          <span className="font-mono text-ink">pip install uv</span>.
        </p>
      )}

      <Button size="sm" onClick={onAdd} disabled={busy || !canAdd}>
        {busy && <Loader2 size={13} className="animate-spin" />}
        Add server
      </Button>
    </div>
  )
}

// ── McpSection ────────────────────────────────────────────────────────────────

function McpSection({ servers, search }: { servers: McpServer[]; search: DaemonSettings['search'] }) {
  const mut = useMcpMutations()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<McpFormState>(emptyMcpForm())
  const [view, setView] = useState<'marketplace' | 'manual' | 'edit'>('marketplace')
  const set = (patch: Partial<McpFormState>) => setForm((p) => ({ ...p, ...patch }))

  const [tab, setTab] = useState<'cloud' | 'local' | 'connected'>('cloud')
  const [activeCat, setActiveCat] = useState('All')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [extraArg, setExtraArg] = useState('')
  const [localEnvs, setLocalEnvs] = useState<Record<string, string>>({})
  // Built-in web search (spec 06 §5 / ADR-082) is selected completely independently of the
  // Cloud/Local marketplace — it's not an MCP server, it's the single active search provider.
  const [selectedBuiltin, setSelectedBuiltin] = useState<BuiltinSearchEntry['id'] | null>(null)
  const [searchSecret, setSearchSecret] = useState('')
  // True once the ACTIVE provider actually has a key/URL saved (not just picked as default).
  const searchConfigured = search.provider === 'tavily' ? search.tavilyKeySet
    : search.provider === 'kagi' ? search.kagiKeySet
    : !!search.searxngUrl?.trim()
  const activeBuiltin = searchConfigured ? BUILTIN_SEARCH.find((b) => b.id === search.provider) : undefined

  const connectedUrls = useMemo(() => new Set(servers.map((s) => s.url).filter(Boolean) as string[]), [servers])
  const connectedNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers])
  const isCatalogConnected = (entry: CloudEntry | LocalEntry) =>
    'url' in entry ? connectedUrls.has((entry as CloudEntry).url) : connectedNames.has(entry.name)
  // Connected tab logo lookup: match a live server back to its catalog entry the same way
  // isCatalogConnected does (cloud by URL, local by name) so it gets the same brand icon the
  // Cloud/Local cards show, instead of falling back to colored initials for every entry.
  const catalogIconFor = (s: McpServer): string | undefined =>
    CLOUD_MCPS.find((e) => e.url === s.url)?.iconSlug ?? LOCAL_MCPS.find((e) => e.name === s.name)?.iconSlug

  const selectCard = (id: string | null) => {
    setSelectedId(id); setApiKey(''); setExtraArg(''); setLocalEnvs({}); setSelectedBuiltin(null)
  }
  const selectBuiltin = (id: BuiltinSearchEntry['id'] | null) => {
    setSelectedBuiltin(id); setSearchSecret(''); setSelectedId(null)
  }
  const switchTab = (t: 'cloud' | 'local' | 'connected') => { setTab(t); setActiveCat('All'); selectCard(null) }

  const cats = tab === 'cloud' ? CLOUD_CATS : LOCAL_CATS
  const filtered = (tab === 'cloud' ? CLOUD_MCPS : LOCAL_MCPS)
    .filter((e) => activeCat === 'All' || e.cat === activeCat)

  const openEdit = (s: McpServer) => { setEditingId(s.id); setForm(serverToForm(s)); setView('edit') }

  const handleSubmit = () => {
    const payload = formToPayload(form)
    if (!payload.name) return void toast.error('Server name is required.')
    if (payload.transport === 'stdio' && !payload.command) return void toast.error('Command is required.')
    if (payload.transport === 'sse' && !payload.url) return void toast.error('URL is required.')
    const isEdit = view === 'edit' && editingId
    const opts = {
      onSuccess: () => { toast.success(isEdit ? 'MCP server updated' : 'MCP server added'); setView('marketplace'); setEditingId(null) },
      onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not save server.'),
    }
    if (isEdit) mut.update.mutate({ id: editingId, patch: payload }, opts)
    else mut.add.mutate(payload, opts)
  }

  const handleDelete = (id: string, name: string) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove MCP server "${name}"?`)) return
    mut.remove.mutate(id, { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove server.') })
  }

  const handleToggle = (s: McpServer) => {
    mut.update.mutate({ id: s.id, patch: { enabled: !s.enabled } }, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update server.'),
    })
  }

  const { save } = useSettings()
  const saveSearch = (provider: NonNullable<DaemonSettings['search']>['provider'], secret: string) => {
    const patch: DaemonSettingsPatch['search'] = { provider }
    if (provider === 'searxng') patch.searxngUrl = secret
    else if (secret.trim()) patch[provider === 'tavily' ? 'tavilyApiKey' : 'kagiApiKey'] = secret
    save.mutate({ search: patch }, {
      onSuccess: () => {
        const displayName = provider === 'tavily' ? 'Tavily' : provider === 'kagi' ? 'Kagi' : 'SearXNG'
        toast.success(`Search set to ${displayName}`)
        selectBuiltin(null)
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save search settings.'),
    })
  }

  const connectCloud = (entry: CloudEntry) => {
    mut.add.mutate({
      name: entry.name, transport: 'sse', url: entry.url, enabled: true,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }, {
      onSuccess: () => { toast.success(`${entry.name} connected`); selectCard(null) },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not add server.'),
    })
  }

  const connectLocal = (entry: LocalEntry) => {
    // entry.cmd is a curated catalog string (no spaces within tokens) — safe to split on space.
    const [command, ...baseArgs] = entry.cmd.trim().split(/\s+/)
    // extraArg is user input that may contain a path with spaces. Tokenize quote-aware so
    // a quoted path ("C:\My Files") stays one arg, while unquoted multi-token input
    // (e.g. --repository /path) still splits into separate args.
    const extra = extraArg.trim()
    const extraArgs = extra
      ? (extra.match(/[^\s"]+|"[^"]*"/g) ?? []).map((t) => t.replace(/^"|"$/g, ''))
      : []
    const args = [...baseArgs, ...extraArgs]
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(localEnvs)) { if (v.trim()) env[k] = v.trim() }
    for (const e of entry.envs) {
      if (e.required && !env[e.key]) return void toast.error(`${e.key} is required.`)
    }
    mut.add.mutate({
      name: entry.name, transport: 'stdio', command, args: args.length ? args : undefined, enabled: true,
      ...(Object.keys(env).length ? { env } : {}),
    }, {
      onSuccess: () => { toast.success(`${entry.name} added`); selectCard(null) },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not add server.'),
    })
  }

  const busy = mut.add.isPending || mut.update.isPending
  const f = form
  const selectedCloud = tab === 'cloud' ? CLOUD_MCPS.find((e) => e.id === selectedId) : undefined
  const selectedLocal = tab === 'local' ? LOCAL_MCPS.find((e) => e.id === selectedId) : undefined

  const renderFormFields = () => (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-muted">Name</label>
        <input type="text" value={f.name} onChange={(e) => set({ name: e.target.value })}
          placeholder="My Tool Server"
          className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none" />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-muted">Transport</label>
        <div className="flex gap-4">
          {(['stdio', 'sse'] as const).map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-1.5 text-[13px] text-ink">
              <input type="radio" name="mcp-transport" checked={f.transport === t}
                onChange={() => set({ transport: t })} className="h-3.5 w-3.5 accent-[var(--accent)]" />
              <span className="font-mono">{t}</span>
              <span className="text-[11px] text-faint">{t === 'stdio' ? '(subprocess)' : '(HTTP)'}</span>
            </label>
          ))}
        </div>
      </div>

      {f.transport === 'stdio' ? (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-muted">Command</label>
            <input type="text" value={f.command} onChange={(e) => set({ command: e.target.value })}
              placeholder="npx -y @modelcontextprotocol/server-filesystem"
              className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-muted">Args <span className="text-faint">(comma-separated, optional)</span></label>
            <input type="text" value={f.argsStr} onChange={(e) => set({ argsStr: e.target.value })}
              placeholder="--port, 3000"
              className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-muted">Env vars <span className="text-faint">(KEY=VALUE, one per line, optional)</span></label>
            <textarea rows={2} value={f.envStr} onChange={(e) => set({ envStr: e.target.value })}
              placeholder={"API_KEY=abc123\nDEBUG=true"}
              className="resize-none rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-muted">URL</label>
            <input type="text" value={f.url} onChange={(e) => set({ url: e.target.value })}
              placeholder="http://localhost:3000"
              className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-muted">API Key <span className="text-faint">(optional — Bearer token)</span></label>
            <input type="password" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })}
              placeholder="sk-…" autoComplete="off"
              className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
          </div>
        </>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })}
          className="h-3.5 w-3.5 accent-[var(--accent)]" />
        Enable immediately
      </label>
    </>
  )

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">MCP Servers</h2>
      <p className="mb-3 text-[12px] text-muted">
        Connect external tool providers via the Model Context Protocol.
      </p>


      {view === 'edit' && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel-2 p-3">
          <div className="text-[13px] font-medium text-ink">Edit server</div>
          {renderFormFields()}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSubmit} disabled={busy}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Update
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setView('marketplace'); setEditingId(null) }}>Cancel</Button>
          </div>
        </div>
      )}

      {view === 'manual' && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel-2 p-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setView('marketplace')}
              className="rounded p-1 text-faint transition-colors hover:text-ink">
              <ArrowLeft size={13} />
            </button>
            <div className="text-[13px] font-medium text-ink">Add server manually</div>
          </div>
          {renderFormFields()}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSubmit} disabled={busy}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Add
            </Button>
            <Button variant="outline" size="sm" onClick={() => setView('marketplace')}>Cancel</Button>
          </div>
        </div>
      )}

      {view === 'marketplace' && (
        <div>
          {/* Built-in web search (spec 06 §5 / ADR-082) — NOT an MCP server, so it's kept
              fully separate from the Cloud/Local marketplace below: exactly one provider is
              active at a time, and clicking one configures only that provider (no shared
              3-way form). */}
          <div className="mb-4 flex flex-col gap-1.5 rounded-lg border border-border bg-panel-2 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Built-in web search</p>
            <div className="flex flex-wrap gap-2">
              {BUILTIN_SEARCH.map((b) => {
                const isActive = search.provider === b.id && searchConfigured
                const isOpen = selectedBuiltin === b.id
                return (
                  <button key={b.id} type="button" onClick={() => selectBuiltin(isOpen ? null : b.id)}
                    className="flex items-center gap-2 rounded-lg border bg-panel px-2.5 py-1.5 text-left transition-colors hover:bg-bg"
                    style={{ borderColor: isOpen ? 'var(--accent)' : isActive ? 'color-mix(in srgb, var(--ok) 50%, transparent)' : 'var(--border, #e2e2e2)' }}>
                    <BrandCircle name={b.name} color={nameColor(b.name)} iconSlug={b.iconSlug} />
                    <span className="text-[13px] font-medium text-ink">{b.name}</span>
                    {isActive && (
                      <span className="flex items-center gap-0.5 text-[10px] font-semibold" style={{ color: 'var(--ok)' }}>
                        <Check size={10} /> Active
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            {selectedBuiltin && (() => {
              const entry = BUILTIN_SEARCH.find((b) => b.id === selectedBuiltin)!
              return (
                <div className="mt-1.5 flex flex-col gap-3 rounded-lg border bg-panel p-3"
                  style={{ borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <BrandCircle name={entry.name} color={nameColor(entry.name)} iconSlug={entry.iconSlug} />
                      <span className="text-[13px] font-medium text-ink">Configure {entry.name}</span>
                    </div>
                    <button type="button" onClick={() => selectBuiltin(null)} className="rounded p-1 text-faint transition-colors hover:text-ink">
                      <X size={13} />
                    </button>
                  </div>

                  <p className="text-[11px] leading-relaxed text-muted">{entry.desc}</p>

                  {entry.id === 'searxng' ? (
                    <div className="flex flex-col gap-1">
                      <label className="text-[12px] text-muted">SearXNG URL</label>
                      <input type="text" value={searchSecret} onChange={(e) => setSearchSecret(e.target.value)}
                        placeholder="http://localhost:8080"
                        className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <label className="text-[12px] text-muted">{entry.name} API Key</label>
                      <input type="password" value={searchSecret} onChange={(e) => setSearchSecret(e.target.value)}
                        placeholder={entry.id === 'tavily' ? 'tvly-…' : 'kg-…'} autoComplete="off"
                        className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none" />
                    </div>
                  )}

                  <Button size="sm" onClick={() => saveSearch(entry.id, searchSecret)} disabled={!searchSecret.trim()}>
                    Save &amp; make active
                  </Button>
                </div>
              )
            })()}
          </div>

          <div className="mb-3 inline-flex rounded-md border border-border p-0.5">
            {(['cloud', 'local', 'connected'] as const).map((t) => (
              <button key={t} type="button" onClick={() => switchTab(t)}
                className={`rounded px-3 py-1 text-[13px] capitalize transition-colors ${tab === t ? 'bg-bg text-ink' : 'text-muted hover:text-ink'}`}>
                {t === 'connected' ? `Connected${servers.length > 0 ? ` (${servers.length})` : ''}` : t === 'cloud' ? 'Cloud' : 'Local'}
              </button>
            ))}
          </div>

          {tab !== 'connected' && (
            <>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {cats.map((cat) => (
                  <button key={cat} type="button" onClick={() => { setActiveCat(cat); selectCard(null) }}
                    className="rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors"
                    style={activeCat === cat
                      ? { background: 'var(--accent)', color: '#fff' }
                      : { background: 'color-mix(in srgb, var(--muted) 12%, transparent)', color: 'var(--muted)' }}>
                    {cat}
                  </button>
                ))}
              </div>

              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(185px, 1fr))' }}>
                {filtered.map((entry) => (
                  <McpCard key={entry.id} entry={entry} tab={tab as 'cloud' | 'local'}
                    isSelected={selectedId === entry.id}
                    isConnected={isCatalogConnected(entry)}
                    onSelect={() => selectCard(selectedId === entry.id ? null : entry.id)} />
                ))}
              </div>

              {selectedCloud && (
                <McpCloudPanel entry={selectedCloud} apiKey={apiKey} onApiKeyChange={setApiKey}
                  onClose={() => selectCard(null)} onConnect={() => connectCloud(selectedCloud)} busy={busy} />
              )}
              {selectedLocal && (
                <McpLocalPanel entry={selectedLocal} extraArg={extraArg} onExtraArgChange={setExtraArg}
                  envs={localEnvs} onEnvChange={(k, v) => setLocalEnvs((p) => ({ ...p, [k]: v }))}
                  onClose={() => selectCard(null)} onAdd={() => connectLocal(selectedLocal)} busy={busy} />
              )}
            </>
          )}

          {tab === 'connected' && (
            <div>
              {servers.length === 0 && !activeBuiltin ? (
                <p className="py-8 text-center text-[12px] text-muted">
                  No MCP servers connected yet. Add one from the Cloud or Local tab.
                </p>
              ) : (
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(185px, 1fr))' }}>
                  {activeBuiltin && (
                    <div className="relative flex flex-col gap-2 rounded-lg border bg-panel-2 p-3"
                      style={{ borderColor: 'color-mix(in srgb, var(--ok) 50%, transparent)' }}>
                      <span className="absolute right-2 top-2 flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold"
                        style={{ background: 'color-mix(in srgb, var(--ok) 15%, transparent)', color: 'var(--ok)' }}>
                        Built-in
                      </span>
                      <div className="flex items-start gap-2.5">
                        <BrandCircle name={activeBuiltin.name} color={nameColor(activeBuiltin.name)} iconSlug={activeBuiltin.iconSlug} />
                        <div className="min-w-0 flex-1 pr-14">
                          <div className="truncate text-[13px] font-semibold text-ink">{activeBuiltin.name}</div>
                          <div className="mt-0.5 text-[10px] text-faint">Web search</div>
                        </div>
                      </div>
                      <button type="button" onClick={() => selectBuiltin(activeBuiltin.id)}
                        className="mt-1 self-start text-[12px] text-muted transition-colors hover:text-ink">
                        Manage
                      </button>
                    </div>
                  )}
                  {servers.map((s) => (
                    <div key={s.id} className="relative flex flex-col gap-2 rounded-lg border bg-panel-2 p-3">
                      <div className="flex items-start gap-2.5">
                        <BrandCircle name={s.name} color={nameColor(s.name)} iconSlug={catalogIconFor(s)} />
                        <div className="min-w-0 flex-1 pr-14">
                          <div className="truncate text-[13px] font-semibold text-ink">{s.name}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            <span className="rounded px-1.5 py-0.5 font-mono text-[10px] font-medium"
                              style={{
                                background: s.transport === 'sse' ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--muted) 20%, transparent)',
                                color: s.transport === 'sse' ? 'var(--accent)' : 'var(--muted)',
                              }}>
                              {s.transport}
                            </span>
                          </div>
                        </div>
                      </div>
                      <span className="hidden max-w-[220px] shrink-0 truncate font-mono text-[11px] text-faint sm:block"
                        title={s.transport === 'stdio' ? s.command : s.url}>
                        {s.transport === 'stdio' ? s.command?.split(/[\\/]/).slice(-1)[0] : s.url}
                      </span>
                      <div className="flex items-center gap-2 pt-1">
                        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink">
                          <input type="checkbox" checked={s.enabled} onChange={() => handleToggle(s)}
                            className="h-3.5 w-3.5 accent-[var(--accent)]" />
                          <span className="text-[11px]">{s.enabled ? 'Enabled' : 'Disabled'}</span>
                        </label>
                        <div className="ml-auto flex gap-1">
                          <button type="button" onClick={() => openEdit(s)} title="Edit"
                            className="rounded p-1 text-faint transition-colors hover:bg-bg hover:text-ink">
                            <Pencil size={12} />
                          </button>
                          <button type="button" onClick={() => handleDelete(s.id, s.name)} title="Delete"
                            className="rounded p-1 transition-colors hover:bg-bg" style={{ color: 'var(--err)' }}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <button type="button"
            onClick={() => { setView('manual'); setForm(emptyMcpForm()); setEditingId(null) }}
            className="mt-4 flex items-center gap-1 text-[12px] text-faint transition-colors hover:text-ink">
            Add server manually <ChevronRight size={11} />
          </button>
        </div>
      )}
    </section>
  )
}
