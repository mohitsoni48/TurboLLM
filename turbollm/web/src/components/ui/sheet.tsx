import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Side sheet — the model config panel. Built on the Radix dialog primitive (for
 * Esc-to-close, focus management, and the data-state the slide animation keys
 * off), but it is NOT a modal: there is no backdrop overlay. Instead it docks to
 * the right and the app shell shrinks to make room (see `.tllm-sheet` /
 * `.app-shell` in index.css):
 *   · mobile  — full-screen, slides in from the right
 *   · desktop — right-docked push panel, slides in from the right
 * Callers pass `modal={false}` on <Sheet> and keep the panel open while the user
 * interacts with the resized content behind it.
 */
// Same Radix root as Dialog, reused so sheets get the same Android hardware-back handling
// (see dialog.tsx's own comment — QA_UX_REPORT.md F-01). Keeping one implementation means a
// sheet can't silently miss the fix the way it did before.
export { Dialog as Sheet } from './dialog'
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Layout/position/width/border are responsive — handled by `.tllm-sheet`.
        'tllm-sheet fixed z-50 flex flex-col border-border bg-panel shadow-[var(--shadow-2)] focus:outline-none',
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
SheetContent.displayName = 'SheetContent'

export function SheetHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1', className)} {...props} />
}

export const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-[16px] font-semibold tracking-[-0.01em] text-ink', className)}
    {...props}
  />
))
SheetTitle.displayName = 'SheetTitle'

export const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-[13px] text-muted', className)}
    {...props}
  />
))
SheetDescription.displayName = 'SheetDescription'
