import { useState } from 'react'
import { Check, Download, Loader2, MoreHorizontal, Sparkles } from 'lucide-react'
import {
  useBackendInstall,
  useEngineBackends,
  useEngineMutations,
  useEngineUpdates,
  useUpdatePolicyMutation,
  useStatus,
} from '../../lib/queries'
import { ApiError, track } from '../../lib/api'
import type { EngineUpdateStatus, UpdatePolicy } from '../../lib/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'

const SIZE_HINT: Record<string, string> = {
  cuda: '~550 MB', rocm: '~320 MB', sycl: '~110 MB', vulkan: '~40 MB', metal: '~11 MB', cpu: '~16 MB',
}

/** Short backend name so rows read "llama.cpp (CUDA)" / "llama.cpp (ROCm)" — each official
 *  llama.cpp backend is presented as its own engine variant. */
const SHORT_BACKEND: Record<string, string> = {
  cuda: 'CUDA', rocm: 'ROCm', sycl: 'SYCL', vulkan: 'Vulkan', metal: 'Metal', cpu: 'CPU',
}

const POLICY_LABEL: Record<UpdatePolicy, string> = {
  off: 'Off',
  notify: 'Notify',
  auto: 'Auto',
}

/** Compact relative-time ("just now", "3h ago", "2d ago") for the last update check. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Honest one-line update status for a backend row. NEVER claims "up to date" without a
 *  real check — an offline/uncheckable engine says so. Returns null when the engine has
 *  no recorded check yet (the row falls back to its installed line). */
function UpdateStatusLine({ st }: { st: EngineUpdateStatus | undefined }) {
  if (!st) return null
  if (st.error === 'offline') {
    return <span className="text-[12px] text-muted">Couldn&apos;t check for updates (offline)</span>
  }
  if (st.error === 'no_source' || !st.comparable) {
    return <span className="text-[12px] text-muted">Update status unavailable for this build</span>
  }
  if (st.hasUpdate && st.latest) {
    return (
      <span className="text-[12px]" style={{ color: 'var(--accent)' }}>
        Update available · {st.installed || '?'} → {st.latest}
      </span>
    )
  }
  return (
    <span className="text-[12px] text-muted">
      Up to date · {st.latest ?? st.installed}
      {st.checkedAt ? ` · checked ${relativeTime(st.checkedAt)}` : ''}
    </span>
  )
}

/** One flat row per official llama.cpp backend variant. Manage-only (download / update /
 *  delete) — switching the active engine is done from the top "Running now" dropdown, not here.
 *  `filter` splits the list: 'recommended' shows only the GPU-recommended backend (for the
 *  catalog), 'others' shows the rest (for the "Other llama.cpp" section). */
export function LlamaCppBackendRows({ filter }: { filter?: 'recommended' | 'others' } = {}) {
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const { data, isLoading } = useEngineBackends(provisioning)
  const { data: updates } = useEngineUpdates(provisioning)
  const install = useBackendInstall()
  const policyMut = useUpdatePolicyMutation()
  // For Disable: unregister the engine entry only (keep files). Uses registry engine id.
  const engineMutForDisable = useEngineMutations()
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null)

  if (isLoading || !data) return null

  // Update status + auto-update policy are keyed by REGISTRY engine id (b.engineId).
  const statusFor = (engineId: string): EngineUpdateStatus | undefined =>
    engineId ? updates?.updates[engineId] : undefined
  const policyFor = (engineId: string): UpdatePolicy =>
    (engineId ? updates?.policies[engineId] : undefined) ?? 'notify'

  const setPolicy = (engineId: string, policy: UpdatePolicy, label: string) => {
    if (!engineId) return
    track('engines', 'set_engine_update_policy')
    policyMut.mutate(
      { id: engineId, policy },
      {
        onSuccess: () => toast.success(`${label} auto-update: ${POLICY_LABEL[policy]}`),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not change auto-update.'),
      },
    )
  }

  const anyPending = provisioning || install.backend.isPending || install.remove.isPending ||
    install.enableBackend.isPending || install.updateBackend.isPending ||
    engineMutForDisable.remove.isPending

  const gpu = data.gpus[0]?.name

  const download = (id: string) => {
    track('engines', 'install_engine')
    install.backend.mutate(id, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not download backend.'),
    })
  }

  const doEnable = (id: string) => {
    track('engines', 'enable_engine')
    install.enableBackend.mutate(id, {
      onSuccess: () => toast.success('Backend enabled'),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not enable backend.'),
    })
  }

  // Disable = unregister from registry only (keep files on disk).
  // engineId is the registry entry id; remove() unregisters without touching disk.
  const doDisable = (engineId: string, label: string) => {
    track('engines', 'disable_engine')
    engineMutForDisable.remove.mutate(engineId, {
      onSuccess: () => toast.success(`${label} disabled`),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not disable backend.'),
    })
  }

  // Update: the daemon reports 'already latest' when the pinned build is present (no download),
  // otherwise it provisions the newer build (progress shows via the engineProvision channel).
  const doUpdate = (id: string) => {
    track('engines', 'update_engine')
    install.updateBackend.mutate(id, {
      onSuccess: (res) =>
        res?.alreadyLatest
          ? toast.success(`You're on the latest build${res.build ? ` (${res.build})` : ''}`)
          : toast.success('Downloading the latest build…'),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update backend.'),
    })
  }

  // Delete = remove files from disk via the backend delete endpoint. backend id (e.g. 'cuda').
  const doDelete = (id: string) => {
    track('engines', 'delete_engine')
    install.remove.mutate(id, {
      onSuccess: () => {
        toast.success(`${deleteTarget?.label ?? 'Backend'} deleted`)
        setDeleteTarget(null)
      },
      onError: (e) => {
        setDeleteTarget(null)
        toast.error(e instanceof ApiError ? e.message : 'Could not delete backend.')
      },
    })
  }

  const rows = data.backends.filter((b) =>
    filter === 'recommended' ? b.recommended : filter === 'others' ? !b.recommended : true,
  )

  return (
    <>
      {rows.map((b) => {
        const up = statusFor(b.engineId)
        const policy = policyFor(b.engineId)
        return (
        <div
          key={b.id}
          className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-panel p-4"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-ink">llama.cpp ({SHORT_BACKEND[b.id] ?? b.label})</span>
              {b.recommended && (
                <span className="flex items-center gap-0.5 text-[11px] text-accent">
                  <Sparkles size={10} /> recommended
                </span>
              )}
              {b.installed && !b.enabled && (
                <Badge variant="mono">Disabled</Badge>
              )}
              {b.installed && b.enabled && up?.hasUpdate && (
                <Badge variant="accent">Update available</Badge>
              )}
            </div>
            <div className="mt-0.5 text-[12px] text-muted">
              {b.installed
                ? `Installed · ${gpu ?? 'GPU detected'}`
                : `Not installed · ${SIZE_HINT[b.id] ?? 'download to use'}`}
            </div>
            {/* Honest per-engine update status (ADR-085) — only for an enabled engine
                we can actually track upstream. Never claims "latest" without a check. */}
            {b.installed && b.enabled && (
              <div className="mt-0.5">
                <UpdateStatusLine st={up} />
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!b.installed ? (
              <Button size="sm" variant="outline" disabled={anyPending} onClick={() => download(b.id)}>
                {provisioning ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                Download
              </Button>
            ) : (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Actions for ${b.label}`}
                    disabled={anyPending}
                    className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
                  >
                    <MoreHorizontal size={16} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => doUpdate(b.id)} disabled={provisioning}>
                      <Download size={14} /> {up?.hasUpdate ? 'Update now' : 'Check for update'}
                    </DropdownMenuItem>
                    {b.enabled ? (
                      <DropdownMenuItem onSelect={() => b.engineId && doDisable(b.engineId, b.label)}>
                        Disable
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => doEnable(b.id)}>
                        Enable
                      </DropdownMenuItem>
                    )}
                    {b.enabled && b.engineId && (
                      <>
                        <DropdownMenuSeparator />
                        <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-faint">
                          Auto-update
                        </div>
                        {(['off', 'notify', 'auto'] as UpdatePolicy[]).map((p) => (
                          <DropdownMenuItem
                            key={p}
                            onSelect={() => setPolicy(b.engineId, p, b.label)}
                            className="flex items-center gap-2"
                          >
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                              {policy === p && <Check size={13} className="text-accent" />}
                            </span>
                            {POLICY_LABEL[p]}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      destructive
                      onSelect={() => setDeleteTarget({ id: b.id, label: b.label })}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
        )
      })}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Files for this engine are removed from disk. Your models are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && doDelete(deleteTarget.id)}
              disabled={install.remove.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
