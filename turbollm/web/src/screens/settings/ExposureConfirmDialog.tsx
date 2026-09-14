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
import { isPublicProvider, type RemoteProviderId } from '../../lib/remote-api'
import { PROVIDER_CARDS } from './remote-provider-cards'

/** Confirmation before a publicly reachable provider goes live (spec 30 §7.2).
 *
 *  Renders NOTHING for tailscale-serve. That is not an oversight to be "fixed" later: Serve
 *  is tailnet-only, so an internet-exposure warning there would be false, and a warning that
 *  cries wolf is one users learn to click through — including on the providers where it is
 *  true.
 *
 *  Built on the shared `components/ui/alert-dialog.tsx` wrapper (every other AlertDialog in
 *  this app goes through it) rather than raw `@radix-ui/react-alert-dialog` primitives — it
 *  already carries the app's real design tokens (bg-panel/text-ink/text-muted, no invented
 *  `bg-surface`/`--on-warn`) and the Android hardware-back handling every overlay needs. */
export function ExposureConfirmDialog({
  provider,
  open,
  onConfirm,
  onCancel,
}: {
  provider: RemoteProviderId
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!isPublicProvider(provider)) return null
  const card = PROVIDER_CARDS[provider]
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>This machine becomes reachable from the internet</AlertDialogTitle>
          <AlertDialogDescription>
            {card.title} will publish this daemon at a public URL. Anyone who has that URL and the
            access token can chat with your models and use your hardware. The token is required —
            requests over the tunnel are never let through without one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="border-[color:var(--warn)] text-[color:var(--warn)] hover:bg-[color:color-mix(in_srgb,var(--warn)_12%,transparent)]"
          >
            Turn it on
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
