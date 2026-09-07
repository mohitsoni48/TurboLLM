import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useBackableOverlay } from '../../lib/use-backable-overlay'

/** Radix's dialog Root, plus Android hardware-back handling for every dialog in the app.
 *
 *  QA_BUGS.md BUG-02 was fixed for the conversation drawer only (ChatScreen calls
 *  useBackableOverlay directly on its own boolean). Every Radix-backed dialog and sheet still
 *  fell through: QA_UX_REPORT.md F-01 caught hardware Back on the "Add your own engine" dialog
 *  tearing down the whole Activity to the launcher — confirmed by `dumpsys activity activities`
 *  showing mResumedActivity flip to com.oppo.launcher — because a Radix open/close never touches
 *  browser history, so DaemonWebView.kt's `canGoBack()` gate stays false and back reaches the
 *  Activity default.
 *
 *  Fixing it here rather than per-dialog is deliberate: that report found the bug on the first
 *  modal it tested and explicitly recommended sweeping every one of them. Wiring the primitive
 *  means existing and future dialogs get it without anyone remembering to. `Sheet` re-exports
 *  this same component (both are @radix-ui/react-dialog under the hood).
 *
 *  Mirrors Radix's own controlled/uncontrolled contract: `open` wins when provided, otherwise
 *  this tracks `defaultOpen` internally, so callers behave exactly as they did before. */
export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isControlled = open !== undefined
  const isOpen = isControlled ? open : uncontrolledOpen

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  useBackableOverlay(
    isOpen,
    React.useCallback(() => handleOpenChange(false), [handleOpenChange]),
  )

  return <DialogPrimitive.Root open={isOpen} onOpenChange={handleOpenChange} {...props} />
}
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

function Overlay({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn('fixed inset-0 z-50 bg-black/40', className)}
      {...props}
    />
  )
}

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <Overlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
        'rounded-[var(--radius-lg)] border border-border bg-panel p-5 shadow-[var(--shadow-2)]',
        'focus:outline-none',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-4 top-4 rounded-sm text-muted hover:text-ink"
        aria-label="Close"
      >
        <X size={16} />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
DialogContent.displayName = 'DialogContent'

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1', className)} {...props} />
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-5 flex flex-wrap justify-end gap-2', className)}
      {...props}
    />
  )
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-[16px] font-semibold tracking-[-0.01em] text-ink', className)}
    {...props}
  />
))
DialogTitle.displayName = 'DialogTitle'

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-[13px] text-muted', className)}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'
