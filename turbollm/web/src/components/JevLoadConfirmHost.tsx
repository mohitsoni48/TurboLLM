// The confirmation a Jev load asks for when something is actually running (ADR-434 (i)(3)).
//
// Mounted once at the app level rather than by the screen that fired the load:
// ModelDetailDialog calls onClose() in the same click that starts the load, so a dialog owned
// by it would unmount before the user could answer. It renders nothing until the store holds a
// confirmation, which is why mounting it costs nothing.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { track } from '../lib/api'
import { useConfirmedLoad } from '../lib/model-loader'
import { useJevLoadStore } from '../stores/jev-load'
import type { ActiveWork, ActiveWorkItem } from '../lib/types'

const UNKNOWN_WORK = "TurboLLM couldn't check what is running right now — loading may interrupt it."

const API_GENERATION = 'a request an API client is generating'

const LABEL_MAX = 60

export function JevLoadConfirmHost() {
  const confirm = useJevLoadStore((s) => s.confirm)
  const setConfirm = useJevLoadStore((s) => s.setConfirm)
  const confirmLoad = useConfirmedLoad()

  if (!confirm) return null
  const { target, work, opts } = confirm

  // Answering the question does not start a load of this dialog's own: it is the interrupted
  // load, resumed. The callbacks the surface that asked for it is waiting on travel in
  // `confirm.opts`, and it claims the same pending key (ADR-436 (6)).
  function loadAnyway() {
    track('models', 'confirm_jev_load')
    confirmLoad(target, opts)
    setConfirm(null)
  }

  function cancel() {
    track('models', 'cancel_jev_load')
    setConfirm(null)
  }

  // AlertDialogAction composes Radix's Close, so closing is also reported after "Load anyway"
  // (ExposureConfirmDialog.tsx hit the same thing). The store answers which it was without a
  // ref that could go stale: a confirmed load has already cleared it. Escape, the backdrop and
  // Android's Back all arrive here, and all of them mean Cancel.
  function handleOpenChange(open: boolean) {
    if (!open && useJevLoadStore.getState().confirm) cancel()
  }

  return (
    <AlertDialog open onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Load {target.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Loading a Jev model stops the running model and interrupts:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="text-sm text-muted list-disc pl-5 space-y-1">
          {interruptedWork(work).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={loadAnyway}>Load anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** One line per thing that stops. A probe that could not be read says so rather than
 *  pretending the list is empty. */
function interruptedWork(work: ActiveWork | null): string[] {
  if (!work) return [UNKNOWN_WORK]
  if (work.items.length > 0) return work.items.map(describeItem)
  return work.engineGenerating ? [API_GENERATION] : []
}

function describeItem(item: ActiveWorkItem): string {
  if (item.kind === 'chat') return `a reply in "${item.label}"`
  if (item.kind === 'code') return `a Code turn in "${item.label}"`
  return `the routine "${truncated(item.label)}"`
}

/** A routine has no name of its own, so it is labelled with its prompt — which can be a whole
 *  paragraph. This dialog lists what stops; it is not the place to read the prompt. */
function truncated(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX).trimEnd()}…` : label
}
