import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import { Bot, ChevronRight, Code2, Globe, Key, Loader2, Lock, Plug, Plus, Sparkles, Terminal, Trash2, Wrench } from 'lucide-react'
import { CopyButton } from '../components/ui/copy-button'
import { ScreenHeader } from '../components/common'
import { Button } from '../components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { useApiKeys, useNetworkInfo } from '../lib/queries'
import { ApiError, getConnect, type ConnectStep, type NetworkInfo } from '../lib/api'
import { toast } from '../components/ui/sonner'
import { cn } from '../lib/utils'

const BASE = window.location.origin

/** Host-only while the LAN is open and unauthenticated (lanBind on, requireApiKey off): in that
 *  state the backend accepts key material from ANY device with no credential at all (spec 06 §5's
 *  "opted into open LAN access") — a non-host viewer could otherwise list/create keys directly, OR
 *  (the connect-setup snippets) get a live key just by loading the page. Mirrors the server-
 *  enforced gate `keysHostGate` in routes.ts (both /api/v1/keys and /api/v1/connect/:cli) — this
 *  hides the UI to match, it isn't the actual security boundary. `net` undefined (still loading)
 *  fails CLOSED so nothing containing key material flashes visible before the real state is known.
 *  ONE shared definition so the two call sites (API keys list, connect-setup snippets) can't drift
 *  out of sync with each other or with the backend rule. */
function isKeysLocked(net: NetworkInfo | undefined): boolean {
  return net ? !net.isHost && !net.requireApiKey : true
}

// Only the endpoints an external app actually builds against (OpenAI + Anthropic
// compatible). The daemon's own internal /api/v1/* management endpoints are not
// listed here — they're not a public API surface.
const PUBLIC_APIS = [
  { method: 'POST', path: '/v1/chat/completions', desc: 'OpenAI Chat Completions' },
  { method: 'POST', path: '/v1/messages', desc: 'Anthropic Messages' },
  { method: 'POST', path: '/v1/embeddings', desc: 'OpenAI Embeddings' },
  { method: 'GET', path: '/v1/models', desc: 'Models list' },
] as const

type Cli = { id: string; name: string; hint: string; icon: LucideIcon }
const CLI_LIST: Cli[] = [
  { id: 'claude-code', name: 'Claude Code', hint: 'turbollm launch claude', icon: Sparkles },
  { id: 'opencode', name: 'opencode', hint: 'turbollm launch opencode', icon: Code2 },
  { id: 'kilo', name: 'Kilo Code', hint: 'turbollm launch kilo', icon: Wrench },
  { id: 'openclaw', name: 'openclaw', hint: 'turbollm launch openclaw', icon: Terminal },
  { id: 'hermes', name: 'Hermes Agent', hint: 'turbollm launch hermes', icon: Bot },
  { id: 'qwen', name: 'Qwen Code', hint: 'OpenAI-compatible', icon: Plug },
]

/** Developer — one job: point an outside app at this server. Connection (URL + keys),
 *  a card grid of one-command CLI setups, and a collapsed API reference. */
export function DeveloperScreen() {
  return (
    <div className="w-full px-4 py-6 md:px-6">
      <ScreenHeader
        title="Developer"
        description="Point Claude Code, Codex, or any OpenAI / Anthropic app at this machine."
      />
      <div className="flex flex-col gap-6">
        <ConnectionPanel />
        <ConnectSection />
        <ApiReferenceSection />
      </div>
    </div>
  )
}

// ── Connection (server URL + API keys) ────────────────────────────────────────

function ConnectionPanel() {
  const { query, create, revoke } = useApiKeys()
  const { data: net } = useNetworkInfo()
  const [newName, setNewName] = useState('')
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const keys = query.data?.keys ?? []

  // window.location.origin alone still reads 127.0.0.1/localhost when you're viewing the
  // dashboard locally even though LAN sharing is on for OTHER devices — show the actually
  // LAN-reachable URL in that case, since that's the address an external app needs.
  const serverUrl = net?.lanBind && net.lanUrl ? net.lanUrl : BASE
  const keysLocked = isKeysLocked(net)

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
      onSuccess: () => { if (justCreated?.startsWith(prefix)) setJustCreated(null) },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not revoke key.'),
    })
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Globe size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Connection</h2>
      </div>

      {/* Server URL — whatever address you're reaching TurboLLM at, or the LAN-reachable
          address when sharing is on (the address an external app actually needs). */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[11px] text-muted">Server URL</div>
          <code className="font-mono text-[13px] text-ink">{serverUrl}</code>
        </div>
        <CopyButton text={serverUrl} />
      </div>

      {/* API keys — needed for access from another device (or when a key is required). */}
      <div className="mt-4">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-muted">
          <Key size={13} /> API keys
        </div>

        {keysLocked ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-bg px-3 py-2.5 text-[13px] text-faint">
            <Lock size={14} className="mt-0.5 shrink-0" />
            <span>
              API key management is only available from this machine until "Require an API key"
              is turned on for LAN access (Settings → Network).
            </span>
          </div>
        ) : (
          <>
            {justCreated && (
              <div
                className="mb-3 rounded-md border p-3"
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
              <p className="mb-3 text-[13px] text-faint">No API keys yet. Create one to connect from another device or an external app.</p>
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
                {create.isPending ? 'Creating…' : 'New key'}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

// ── Connect an app ────────────────────────────────────────────────────────────

function ConnectSection() {
  const { data: net } = useNetworkInfo()
  const [selected, setSelected] = useState<string>(CLI_LIST[0].id)
  const cli = CLI_LIST.find((c) => c.id === selected) ?? CLI_LIST[0]
  // Setup snippets embed a live API key when the daemon is LAN-exposed (routes.ts's
  // GET /api/v1/connect/:cli mints one on every call) — same lock as the API-keys list above,
  // and just as necessary here: unlike that list, this fires automatically the moment the
  // page loads (no click needed) for whichever CLI is selected by default.
  const keysLocked = isKeysLocked(net)

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Terminal size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Connect an app</h2>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {CLI_LIST.map((c) => (
          <AppCard key={c.id} cli={c} selected={c.id === selected} onSelect={() => setSelected(c.id)} />
        ))}
      </div>

      {keysLocked ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-border bg-panel p-4 text-[13px] text-faint">
          <Lock size={14} className="mt-0.5 shrink-0" />
          <span>
            Setup snippets include a live API key, so they're only available from this machine
            until "Require an API key" is turned on for LAN access (Settings → Network).
          </span>
        </div>
      ) : (
        <SetupPanel key={cli.id} cli={cli} />
      )}
    </section>
  )
}

function AppCard({ cli, selected, onSelect }: { cli: Cli; selected: boolean; onSelect: () => void }) {
  const Icon = cli.icon
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex items-center gap-2.5 rounded-[10px] border bg-panel px-3 py-2.5 text-left transition-colors hover:border-[color:var(--accent)]"
      style={{ borderColor: selected ? 'var(--accent)' : 'var(--border)', borderWidth: selected ? 2 : 1 }}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-panel-2 text-muted">
        <Icon size={16} />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-ink">{cli.name}</div>
        <div className="truncate font-mono text-[11px] text-muted">{cli.hint}</div>
      </div>
    </button>
  )
}

function SetupPanel({ cli }: { cli: Cli }) {
  const q = useQuery({ queryKey: ['connect', cli.id], queryFn: () => getConnect(cli.id) })
  return (
    <div
      className="mt-3 rounded-xl border bg-panel p-4"
      style={{ borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border))' }}
    >
      <div className="mb-3 text-[13px] font-medium text-ink">{cli.name} — setup</div>
      {q.isLoading && (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}
      {q.isError && <p className="text-[13px]" style={{ color: 'var(--err)' }}>Could not fetch setup snippets.</p>}
      {q.data && (
        <div className="flex flex-col gap-2.5">
          {q.data.steps.map((step, i) => (
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

// ── API reference (collapsed) ─────────────────────────────────────────────────

function ApiReferenceSection() {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-panel p-4">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <ChevronRight size={14} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">API reference</h2>
        <span className="ml-auto text-[11px] text-muted">OpenAI + Anthropic compatible</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 divide-y divide-border rounded-md border border-border">
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
      </CollapsibleContent>
    </Collapsible>
  )
}
