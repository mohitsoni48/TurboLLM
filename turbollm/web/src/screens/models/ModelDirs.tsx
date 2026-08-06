import { useState, type ReactNode } from 'react'
import { FolderPlus, Star, X } from 'lucide-react'
import { ApiError, track } from '../../lib/api'
import { useModelMutations } from '../../lib/queries'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

export function ModelDirs({
  dirs,
  primaryDir,
  mut,
}: {
  dirs: string[]
  primaryDir: string
  mut: ReturnType<typeof useModelMutations>
}) {
  const [value, setValue] = useState('')
  const addError = mut.addDir.error instanceof ApiError ? mut.addDir.error.message : null

  const add = () => {
    const dir = value.trim()
    if (!dir) return
    track('models', 'add_model_dir')
    mut.addDir.mutate(dir, { onSuccess: () => setValue('') })
  }

  return (
    <div className="mb-5 rounded-lg border border-border bg-panel-2 p-4">
      <div className="mb-2 text-[13px] font-medium text-ink">Model folders</div>
      {dirs.length > 0 && (
        <div className="mb-3 flex flex-col gap-1.5">
          {dirs.map((d) => {
            const isPrimary = d === primaryDir
            return (
              <div key={d} className="group/dir flex items-center gap-2 text-[13px]">
                <span className="flex-1 truncate font-mono text-muted">{d}</span>
                {isPrimary ? (
                  <Tag tone="ok">Primary</Tag>
                ) : (
                  <button
                    type="button"
                    onClick={() => { track('models', 'set_primary_model_dir'); mut.setPrimaryDir.mutate(d) }}
                    disabled={mut.setPrimaryDir.isPending}
                    title="Downloads and imports will land in this folder"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-faint opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover/dir:opacity-100"
                  >
                    <Star size={12} />
                    Set as primary
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${d}`}
                  onClick={() => { track('models', 'remove_model_dir'); mut.removeDir.mutate(d) }}
                  className="rounded p-1 text-muted transition-colors hover:text-ink"
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Paste an absolute folder path, e.g. D:\\models"
          className="flex-1 font-mono text-[13px]"
        />
        <Button size="sm" onClick={add} disabled={mut.addDir.isPending || !value.trim()}>
          <FolderPlus size={14} />
          Add folder
        </Button>
      </div>
      {addError && <p className="mt-2 text-[12px]" style={{ color: 'var(--err)' }}>{addError}</p>}
    </div>
  )
}

function Tag({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'err' | 'spec' }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'err' ? 'var(--err)' : tone === 'spec' ? 'var(--accent)' : 'var(--muted)'
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {children}
    </span>
  )
}
