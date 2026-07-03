import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, MessageSquarePlus, Pencil, Search, Trash2 } from 'lucide-react'
import type { Conversation } from '../../lib/chat-types'
import { useConversationMutations, useConversations } from '../../lib/chat-queries'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { toast } from '../../components/ui/sonner'
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

/** localStorage key for the client-only "confirm before deleting a conversation"
 *  preference (mirrors SettingsScreen). Default ON when unset. */
const CONFIRM_DELETE_KEY = 'tllm.confirmDeleteConversation'
const confirmDeleteEnabled = (): boolean => localStorage.getItem(CONFIRM_DELETE_KEY) !== 'false'

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000)  return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

export function ConversationSidebar({
  activeId,
  onSelect,
  onNew,
  onImport,
  collapsed,
  onToggle,
  generating,
  onDeleted,
}: {
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  /** Called when the user clicks "Import chat" — opens the file picker in the parent. */
  onImport?: () => void
  collapsed?: boolean
  onToggle?: () => void
  /** True when a generation is streaming in the active conversation. */
  generating?: boolean
  /** Called after a conversation is deleted so the parent can clear its active
   *  reference when the deleted conversation was the open one. */
  onDeleted?: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  // Conversation queued for a confirmation dialog (null = dialog closed).
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const mut = useConversationMutations()
  const convsQ = useConversations(debouncedQ || undefined)
  const convs = convsQ.data?.conversations ?? []

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200)
    return () => clearTimeout(t)
  }, [q])

  // Ctrl+K focuses search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Actually delete a conversation. If it was the active one, tell the parent so
  // it can close/clear the now-dangling reference.
  const doDelete = (conv: Conversation) => {
    const wasActive = conv.id === activeId
    mut.remove.mutate(conv.id, {
      onSuccess: () => {
        toast.success('Conversation deleted')
        if (wasActive) onDeleted?.(conv.id)
      },
      onError: () => { toast.error('Could not delete conversation.') },
    })
  }

  const onDelete = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    // When confirmation is enabled, queue the dialog; otherwise delete immediately.
    if (confirmDeleteEnabled()) setPendingDelete(conv)
    else doDelete(conv)
  }

  // Warn that an in-flight generation will be lost only when deleting the active,
  // currently-generating conversation.
  const pendingIsActiveGenerating = !!pendingDelete && pendingDelete.id === activeId && !!generating

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 border-r border-border bg-panel-2 py-3">
        {onToggle && (
          <Button size="icon" variant="ghost" onClick={onToggle} title="Expand sidebar" className="h-7 w-7">
            <ChevronRight size={15} />
          </Button>
        )}
        <Button size="icon" variant="ghost" onClick={onNew} title="New chat (Ctrl+N)" className="h-7 w-7">
          <MessageSquarePlus size={15} />
        </Button>
        {onImport && (
          <Button size="icon" variant="ghost" onClick={onImport} title="Import chat (.turbollm-chat.json or OpenAI JSON)" className="h-7 w-7">
            <Download size={15} />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-panel-2">
      <div className="flex items-center gap-2 px-3 py-3">
        {onToggle && (
          <Button size="icon" variant="ghost" onClick={onToggle} title="Collapse sidebar" className="h-7 w-7 shrink-0">
            <ChevronLeft size={15} />
          </Button>
        )}
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="h-7 pl-7 text-[12px]"
          />
        </div>
        <Button size="icon" variant="ghost" onClick={onNew} title="New chat (Ctrl+N)" className="h-7 w-7 shrink-0">
          <MessageSquarePlus size={15} />
        </Button>
        {onImport && (
          <Button size="icon" variant="ghost" onClick={onImport} title="Import chat (.turbollm-chat.json or OpenAI JSON)" className="h-7 w-7 shrink-0">
            <Download size={15} />
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {convs.length === 0 && (
          <p className="px-3 py-4 text-[12px] text-faint">{q ? 'No results.' : 'No conversations yet.'}</p>
        )}
        {convs.map((conv) => (
          <ConvItem key={conv.id} conv={conv} active={conv.id === activeId} onSelect={onSelect} onDelete={onDelete} />
        ))}
      </div>

      {/* Delete confirmation (only shown when the "confirm before delete" setting is on). */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? (
                <>
                  <span className="font-medium text-ink">{pendingDelete.title || 'Untitled conversation'}</span>{' '}
                  will be permanently deleted. This can’t be undone.
                  {pendingIsActiveGenerating && (
                    <> A response is still generating in this conversation — it will be stopped and lost.</>
                  )}
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingDelete) doDelete(pendingDelete); setPendingDelete(null) }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ConvItem({
  conv,
  active,
  onSelect,
  onDelete,
}: {
  conv: Conversation
  active: boolean
  onSelect: (id: string) => void
  onDelete: (e: React.MouseEvent, conv: Conversation) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const mut = useConversationMutations()

  const commitRename = () => {
    setEditing(false)
    const title = draft.trim()
    if (!title || title === conv.title) { setDraft(conv.title); return }
    mut.update.mutate(
      { id: conv.id, title },
      { onError: () => { setDraft(conv.title); toast.error('Could not rename conversation.') } },
    )
  }

  return (
    <div
      onClick={() => !editing && onSelect(conv.id)}
      className="group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 transition-colors"
      style={{ background: active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent' }}
    >
      {editing ? (
        <input
          autoFocus
          className="w-full bg-transparent text-[13px] font-medium text-ink outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setDraft(conv.title); setEditing(false) } }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="truncate text-[13px] font-medium text-ink"
          style={{ color: active ? 'var(--accent)' : undefined }}
          onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
        >
          {conv.title}
        </span>
      )}
      <span className="text-[11px] text-faint">{relTime(conv.updatedAt)}</span>
      {!editing && (
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDraft(conv.title); setEditing(true) }}
            className="rounded p-1 text-faint transition-colors hover:text-ink"
            title="Rename conversation"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={(e) => onDelete(e, conv)}
            className="rounded p-1 text-faint transition-colors hover:text-err"
            title="Delete conversation"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
