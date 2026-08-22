import { useEffect, useState } from 'react'
import { Link2, Loader2, Plus, Trash2, RefreshCw, Check, AlertTriangle, ChevronRight } from 'lucide-react'
import {
  addLink,
  deleteLink,
  listInbound,
  listLinks,
  mintLink,
  patchLink,
  revokeInbound,
  type ApiKeyId,
  type InboundLink,
  type LinkCapability,
  type LinkRecord,
  type LinkStatus,
  type MintedLink,
} from '../../lib/link-api'
import { LINK_CAPABILITIES, LINK_PRESETS } from '../../lib/link-constants'
import { ApiError, getSettings, saveSettings, track } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { CopyButton } from '../../components/ui/copy-button'
import { toast } from '../../components/ui/sonner'
import { cn } from '../../lib/utils'

/** The preset rows. The copy is the ONLY place the user learns what they are handing over,
 *  so it says what the capability actually does rather than repeating its name.
 *
 *  "Full control" in particular used to read "everything above, plus downloads and config",
 *  which understated both halves: `downloads:write` writes multi-gigabyte files to this
 *  machine's disk and may cancel downloads its owner started, and `config:write` reaches
 *  settings this machine reads for its OWN local use — the per-response token cap is
 *  clamped onto local chat too, and auto-swap / keep-N change how much VRAM this machine
 *  commits on the owner's own subsequent loads. */
const PRESET_OPTIONS: { id: keyof typeof LINK_PRESETS; label: string; description: string }[] = [
  { id: 'inference', label: 'Inference only', description: 'Use models to generate — nothing else.' },
  { id: 'server', label: 'Server box', description: 'Use, wake, load, and unload models.' },
  {
    id: 'full',
    label: 'Full control',
    description:
      'Everything above, plus downloading models to this machine (multi-gigabyte files, '
      + 'and cancelling downloads you started), and changing this machine’s model, gateway '
      + 'and appearance defaults — including the token cap and VRAM settings this machine '
      + 'applies to its own local chats.',
  },
]

/** What each raw capability grants, for the Customize list. Same rule as the presets: the
 *  id alone ("config:write") tells the user nothing about what it reaches. */
const CAPABILITY_NOTES: Record<LinkCapability, string> = {
  'models:use': 'Send prompts to models already loaded here.',
  'models:wake': 'Bring a cold model up to serve a request.',
  'models:load': 'Load any model in this machine’s library, evicting what is loaded.',
  'models:unload': 'Stop this machine’s engine, including a model you are using locally.',
  'downloads:read': 'See this machine’s download queue.',
  'downloads:write': 'Download models onto this machine’s disk, and cancel downloads — including your own.',
  'config:read': 'Read this machine’s model, gateway and appearance defaults.',
  'config:write':
    'Change those defaults — context size, GPU layers, the per-response token cap and how '
    + 'many models stay loaded. These apply to this machine’s own local use too. There is no '
    + 'in-app screen for remote settings yet; it is reachable only through the API.',
}

/** Small pill for one granted capability. Always rendered from a record's
 *  `grantedCapabilities` (or a mint draft's own selection) — never inferred. */
function CapabilityChip({ cap }: { cap: LinkCapability }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-panel-2 px-2 py-0.5 text-[11px] font-mono text-muted">
      {cap}
    </span>
  )
}

/** Status dot + message. `lastError` is always the visible text for a non-online link —
 *  never a bare "offline" — so the three distinct failure states (unreachable / revoked /
 *  incompatible) each surface their own actionable sentence. */
function StatusLine({ status, lastError }: { status: LinkStatus; lastError: string | null }) {
  if (status === 'online') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--ok)' }}>
        <Check size={13} /> Online
      </span>
    )
  }
  const message = lastError ?? (status === 'unknown' ? 'Not checked yet.' : 'Not reachable.')
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: status === 'unknown' ? 'var(--muted)' : 'var(--warn)' }}>
      <AlertTriangle size={13} /> {message}
    </span>
  )
}

export function TurboLinkSection() {
  const [inbound, setInbound] = useState<InboundLink[] | null>(null)
  const [links, setLinks] = useState<LinkRecord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const reloadInbound = () => {
    void listInbound().then(setInbound).catch((e) => setLoadError(e instanceof ApiError ? e.message : 'Could not load inbound links.'))
  }
  const reloadLinks = () => {
    void listLinks().then(setLinks).catch((e) => setLoadError(e instanceof ApiError ? e.message : 'Could not load linked machines.'))
  }

  useEffect(() => {
    reloadInbound()
    reloadLinks()
  }, [])

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-1 flex items-center gap-2">
          <Link2 size={15} className="text-accent" />
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Turbo Link</h2>
        </div>
        <p className="mb-3 text-[12px] text-muted">
          Link two TurboLLM machines so one can use the other's models. Permissions ride on a
          scoped token — grant only what a peer actually needs.
        </p>

        {loadError && <p className="mb-3 text-[12px]" style={{ color: 'var(--err)' }}>{loadError}</p>}

        <HostPanel inbound={inbound} onMinted={reloadInbound} onRevoked={reloadInbound} />
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-1 flex items-center gap-2">
          <Link2 size={15} className="text-accent" />
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Linked machines</h2>
        </div>
        <p className="mb-3 text-[12px] text-muted">
          Machines this TurboLLM has linked to, using a link string minted on the host above.
        </p>
        <PeerPanel links={links} onChanged={reloadLinks} />
      </div>
    </section>
  )
}

/** What a linked peer displays for THIS machine. Persisted as `daemon.machineName`.
 *  Blank is a legal value and means "use the OS hostname" — the daemon resolves that at
 *  handshake time, so the placeholder promises a hostname rather than inventing a name
 *  here. Before this field existed nothing ever wrote `machineName`, so every host in
 *  the world answered with the same constant "TurboLLM" and a peer with two links saw
 *  two identical rows. */
function MachineNameField() {
  const [value, setValue] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void getSettings()
      .then((s) => { setValue(s.machineName ?? ''); setSaved(s.machineName ?? '') })
      .catch(() => setValue(''))
  }, [])

  const dirty = value !== null && value.trim() !== saved
  const doSave = () => {
    if (value === null || !dirty) return
    setSaving(true)
    track('settings', 'set_machine_name')
    void saveSettings({ machineName: value.trim() })
      .then((s) => { setSaved(s.machineName ?? ''); setValue(s.machineName ?? '') })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the machine name.'))
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-[12px] text-muted" htmlFor="turbo-link-machine-name">
        Machine name (what linked peers call this machine)
      </label>
      <div className="flex items-center gap-2">
        <input
          id="turbo-link-machine-name"
          type="text"
          value={value ?? ''}
          disabled={value === null}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doSave() }}
          placeholder="Leave blank to use this computer's hostname"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
        />
        {dirty && (
          <Button size="sm" variant="outline" onClick={doSave} disabled={saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Save
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Host panel: mint a link for another machine, and see who is linked in ───────────

function HostPanel({
  inbound,
  onMinted,
  onRevoked,
}: {
  inbound: InboundLink[] | null
  onMinted: () => void
  onRevoked: () => void
}) {
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<keyof typeof LINK_PRESETS>('inference')
  const [customize, setCustomize] = useState(false)
  const [customCaps, setCustomCaps] = useState<Set<LinkCapability>>(new Set(LINK_PRESETS.inference))
  const [models, setModels] = useState('')
  const [minting, setMinting] = useState(false)
  const [minted, setMinted] = useState<MintedLink | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const activeCaps = customize ? Array.from(customCaps) : LINK_PRESETS[preset]

  const toggleCap = (cap: LinkCapability) => {
    setCustomCaps((prev) => {
      const next = new Set(prev)
      if (next.has(cap)) next.delete(cap)
      else next.add(cap)
      return next
    })
  }

  const doMint = async () => {
    if (!name.trim()) {
      toast.error('Give the link a name first.')
      return
    }
    if (activeCaps.length === 0) {
      toast.error('Grant at least one capability.')
      return
    }
    setMinting(true)
    track('settings', 'mint_link')
    try {
      const modelList = models.split(',').map((m) => m.trim()).filter(Boolean)
      const result = await mintLink({
        name: name.trim(),
        capabilities: activeCaps,
        models: modelList.length ? modelList : undefined,
        // Reporting-only (the grant is `capabilities`), but it must be SENT or the
        // server's `preset` telemetry dimension is always absent. A custom selection
        // has no preset name, so it is omitted rather than mislabelled.
        preset: customize ? undefined : preset,
      })
      setMinted(result)
      setName('')
      setModels('')
      onMinted()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not mint a link.')
    } finally {
      setMinting(false)
    }
  }

  // An inbound link is an API KEY with a grant, so revoking it deletes the key
  // (/api/v1/keys/:id). It is NOT a peer-side link record — calling deleteLink here
  // returned {ok:true}, refetched an unchanged list, and left the peer's token working.
  const doRevoke = (id: ApiKeyId) => {
    setRevokingId(id)
    track('settings', 'revoke_inbound_link')
    void revokeInbound(id)
      .then(() => onRevoked())
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not revoke this link.'))
      .finally(() => setRevokingId(null))
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[13px] font-medium text-ink">This machine</div>

      <MachineNameField />

      <div className="flex flex-col gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. laptop"
          spellCheck={false}
          autoComplete="off"
          className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
        />

        <div className="flex flex-col gap-1.5">
          {PRESET_OPTIONS.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="link-preset"
                checked={!customize && preset === p.id}
                onChange={() => { setCustomize(false); setPreset(p.id) }}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              <div>
                <div className="text-[13px] text-ink">{p.label}</div>
                <div className="text-[11px] text-muted">{p.description}</div>
              </div>
            </label>
          ))}
        </div>

        <Collapsible open={customize} onOpenChange={setCustomize}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink">
            <ChevronRight size={12} className={cn('transition-transform', customize && 'rotate-90')} />
            Customize
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 flex flex-col gap-1.5 border-l border-border pl-3">
              {LINK_CAPABILITIES.map((cap) => (
                <label key={cap} className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={customCaps.has(cap)}
                    onChange={() => toggleCap(cap)}
                    className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-[12px] text-ink">{cap}</span>
                    <span className="block text-[11px] text-muted">{CAPABILITY_NOTES[cap]}</span>
                  </span>
                </label>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-muted">Model allowlist (optional, comma-separated)</label>
          <input
            type="text"
            value={models}
            onChange={(e) => setModels(e.target.value)}
            placeholder="Leave blank for every local model"
            spellCheck={false}
            autoComplete="off"
            className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
          />
        </div>

        <div>
          <Button size="sm" onClick={() => void doMint()} disabled={minting}>
            {minting ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Create link
          </Button>
        </div>
      </div>

      {minted && (
        <div
          className="flex flex-col gap-2 rounded-md border p-3"
          style={{ borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
        >
          <div className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--warn)' }}>
            <AlertTriangle size={13} /> This link string is shown only once — copy it now. It cannot be re-shown.
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={minted.linkString}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
            />
            <CopyButton text={minted.linkString} screen="settings" />
          </div>
        </div>
      )}

      <div className="border-t border-border pt-3">
        <div className="mb-2 text-[13px] font-medium text-ink">Linked to this machine</div>
        {inbound === null && <p className="text-[12px] text-faint">Loading…</p>}
        {inbound !== null && inbound.length === 0 && <p className="text-[12px] text-faint">No machine has linked in yet.</p>}
        {inbound !== null && inbound.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {inbound.map((link) => (
              <div key={link.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink">{link.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {link.capabilities.map((cap) => <CapabilityChip key={cap} cap={cap} />)}
                  </div>
                  <div className="mt-1 text-[11px] text-faint">
                    {link.lastUsedAt ? `Last used ${link.lastUsedAt}` : 'Never used'}
                  </div>
                </div>
                <button
                  type="button"
                  title="Revoke"
                  onClick={() => doRevoke(link.id)}
                  disabled={revokingId === link.id}
                  className="shrink-0 rounded p-1 transition-colors hover:bg-bg disabled:opacity-60"
                  style={{ color: 'var(--err)' }}
                >
                  {revokingId === link.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Peer panel: link to another machine, and manage those links ─────────────────────

function PeerPanel({ links, onChanged }: { links: LinkRecord[] | null; onChanged: () => void }) {
  const [linkString, setLinkString] = useState('')
  const [adding, setAdding] = useState(false)

  const doAdd = async () => {
    if (!linkString.trim()) return
    setAdding(true)
    track('settings', 'add_link')
    try {
      await addLink(linkString.trim())
      setLinkString('')
      onChanged()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not add this link.')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={linkString}
          onChange={(e) => setLinkString(e.target.value)}
          placeholder="Paste a link string (tllink_…)"
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Enter') void doAdd() }}
          className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
        />
        <Button size="sm" onClick={() => void doAdd()} disabled={adding || !linkString.trim()}>
          {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          Link a machine
        </Button>
      </div>

      {links === null && <p className="text-[12px] text-faint">Loading…</p>}
      {links !== null && links.length === 0 && <p className="text-[12px] text-faint">No linked machines yet.</p>}
      {links !== null && links.length > 0 && (
        <div className="flex flex-col gap-3">
          {links.map((link) => <LinkRow key={link.id} link={link} onChanged={onChanged} />)}
        </div>
      )}
    </div>
  )
}

function LinkRow({ link, onChanged }: { link: LinkRecord; onChanged: () => void }) {
  const [baseUrl, setBaseUrl] = useState(link.baseUrl)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const dirty = baseUrl.trim() !== link.baseUrl

  useEffect(() => { setBaseUrl(link.baseUrl) }, [link.baseUrl])

  const doSave = () => {
    if (!dirty) return
    setSaving(true)
    track('settings', 'edit_link_url')
    void patchLink(link.id, { baseUrl: baseUrl.trim() })
      .then(() => onChanged())
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not update this link.'))
      .finally(() => setSaving(false))
  }

  // Clearing the latched anti-hijack warning is an explicit act, never a side effect of a
  // poll: the record already adopted the new machineId, so until a human confirms it, this
  // link may be pointing at a stranger's daemon.
  const doAcknowledge = () => {
    setSaving(true)
    track('settings', 'ack_link_machine_change')
    void patchLink(link.id, { acknowledgeMachineChange: true })
      .then(() => onChanged())
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not update this link.'))
      .finally(() => setSaving(false))
  }

  const doRemove = () => {
    setRemoving(true)
    track('settings', 'remove_link')
    void deleteLink(link.id)
      .then(() => onChanged())
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove this link.'))
      .finally(() => setRemoving(false))
  }

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">{link.name}</div>
          <StatusLine status={link.status} lastError={link.lastError} />
        </div>
        <button
          type="button"
          title="Remove"
          onClick={doRemove}
          disabled={removing}
          className="shrink-0 rounded p-1 transition-colors hover:bg-bg disabled:opacity-60"
          style={{ color: 'var(--err)' }}
        >
          {removing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </button>
      </div>

      {link.machineIdChanged && (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 rounded-md border p-2"
          style={{ borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
        >
          <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--warn)' }}>
            <AlertTriangle size={13} />
            This URL now answers as a different machine than the one you linked.
          </span>
          <Button size="sm" variant="outline" onClick={doAcknowledge} disabled={saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            This is the right machine
          </Button>
        </div>
      )}

      {link.grantedCapabilities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {link.grantedCapabilities.map((cap) => <CapabilityChip key={cap} cap={cap} />)}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doSave() }}
          spellCheck={false}
          autoComplete="off"
          aria-label="Base URL"
          className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
        />
        {dirty && (
          <Button size="sm" variant="outline" onClick={doSave} disabled={saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Save
          </Button>
        )}
      </div>
    </div>
  )
}
