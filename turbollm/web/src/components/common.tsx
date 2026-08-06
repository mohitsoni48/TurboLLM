import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '../lib/utils'
import { track } from '../lib/api'
import { Button } from './ui/button'

/** Inline error alert with optional retry (spec 11 §8). `screen` is required whenever
 *  `onRetry` is passed (the Retry button only renders then) — TypeScript can't express that
 *  conditional requirement cleanly here, so it's just always required; callers with no retry
 *  pass whichever screen they're on anyway, harmlessly unused. */
export function InlineError({
  message,
  onRetry,
  className,
  screen,
}: {
  message: string
  onRetry?: () => void
  className?: string
  screen: 'tokens' | 'models' | 'routines' | 'engines'
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border p-3 text-[13px]',
        className,
      )}
      style={{
        borderColor: 'var(--err)',
        background: 'color-mix(in srgb, var(--err) 10%, transparent)',
        color: 'var(--ink)',
      }}
      role="alert"
    >
      <AlertTriangle size={16} style={{ color: 'var(--err)' }} className="mt-0.5 shrink-0" />
      <div className="flex-1">{message}</div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={() => { track(screen, 'retry_failed_load'); onRetry() }}>
          Retry
        </Button>
      )}
    </div>
  )
}

/** Single-icon empty state: icon + one sentence + one CTA (spec 11 §8). */
export function EmptyState({
  icon,
  message,
  action,
}: {
  icon: ReactNode
  message: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="text-muted">{icon}</div>
      <p className="max-w-sm text-[13px] text-muted">{message}</p>
      {action}
    </div>
  )
}

/** Screen title row used at the top of each screen. */
export function ScreenHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  )
}
