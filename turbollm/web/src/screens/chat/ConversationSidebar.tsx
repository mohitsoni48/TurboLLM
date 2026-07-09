import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Circle, Download, Folder as FolderIcon, FolderInput, FolderPlus, Loader2, MessageSquarePlus, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react'
import type { Conversation, Folder } from '../../lib/chat-types'
import { useConversationMutations, useConversations, useFolders } from '../../lib/chat-queries'
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'

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
  generatingIds,
  recentlyCompletedIds,
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
  /** Ids of every conversation currently streaming a generation (including ones the
   *  user has navigated away from) — drives the spinning in-progress indicator. */
  generatingIds?: Set<string>
  /** Ids of conversations whose generation finished while the user was elsewhere —
   *  drives the "new result" dot until the user visits that conversation. */
  recentlyCompletedIds?: Set<string>
  /** Called after a conversation is deleted so the parent can clear its active
   *  reference when the deleted conversation was the open one. */
  onDeleted?: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  // Conversation queued for a confirmation dialog (null = dialog closed).
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  // Folder queued for a delete-confirmation dialog (null = dialog closed).
  const [pendingFolderDelete, setPendingFolderDelete] = useState<Folder | null>(null)
  // Which folder sections are open. Not persisted — resets on remount.
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  // True while the inline "new folder" name input is showing.
  const [addingFolder, setAddingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const mut = useConversationMutations()
  const convsQ = useConversations(debouncedQ || undefined)
  const convs = convsQ.data?.conversations ?? []
  const foldersQ = useFolders()
  const folders = foldersQ.data?.folders ?? []

  const searching = !!debouncedQ

  // Bucket conversations by folderId (only used when not searching). Conversations
  // whose folderId is null/undefined OR points at a folder that no longer exists fall
  // into the "ungrouped" bucket.
  const { byFolder, ungrouped } = useMemo(() => {
    const known = new Set(folders.map((f) => f.id))
    const byFolder = new Map<string, Conversation[]>()
    const ungrouped: Conversation[] = []
    for (const conv of convs) {
      const fid = conv.folderId
      if (fid && known.has(fid)) {
        const arr = byFolder.get(fid) ?? []
        arr.push(conv)
        byFolder.set(fid, arr)
      } else {
        ungrouped.push(conv)
      }
    }
    return { byFolder, ungrouped }
  }, [convs, folders])

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

  const toggleFolder = (id: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

  const onMove = (conv: Conversation, folderId: string | null) => {
    mut.moveToFolder.mutate(
      { convId: conv.id, folderId },
      { onError: () => { toast.error('Could not move conversation.') } },
    )
  }

  const commitNewFolder = () => {
    const name = newFolderName.trim()
    setAddingFolder(false)
    setNewFolderName('')
    if (!name) return
    mut.createFolder.mutate(name, {
      onSuccess: (folder) => { setOpenFolders((prev) => new Set(prev).add(folder.id)) },
      onError: () => { toast.error('Could not create folder.') },
    })
  }

  const doDeleteFolder = (folder: Folder) => {
    mut.deleteFolder.mutate(folder.id, {
      onSuccess: () => { toast.success('Folder deleted') },
      onError: () => { toast.error('Could not delete folder.') },
    })
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
        <Button size="icon" variant="ghost" onClick={() => { setAddingFolder(true); setNewFolderName('') }} title="New folder" className="h-7 w-7 shrink-0">
          <FolderPlus size={15} />
        </Button>
        {onImport && (
          <Button size="icon" variant="ghost" onClick={onImport} title="Import chat (.turbollm-chat.json or OpenAI JSON)" className="h-7 w-7 shrink-0">
            <Download size={15} />
          </Button>
        )}
      </div>

      {/* Inline "new folder" name input — mirrors the conversation-rename inline UX. */}
      {addingFolder && (
        <div className="flex items-center gap-2 px-3 pb-2">
          <FolderIcon size={13} className="shrink-0 text-faint" />
          <input
            autoFocus
            className="w-full bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-faint"
            value={newFolderName}
            placeholder="Folder name…"
            onChange={(e) => setNewFolderName(e.target.value)}
            onBlur={commitNewFolder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNewFolder()
              if (e.key === 'Escape') { setAddingFolder(false); setNewFolderName('') }
            }}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {/* When searching, keep the flat, ungrouped list exactly as before. */}
        {searching ? (
          <>
            {convs.length === 0 && (
              <p className="px-3 py-4 text-[12px] text-faint">No results.</p>
            )}
            {convs.map((conv) => (
              <ConvItem
                key={conv.id}
                conv={conv}
                active={conv.id === activeId}
                folders={folders}
                onSelect={onSelect}
                onDelete={onDelete}
                onMove={onMove}
                generating={generatingIds?.has(conv.id)}
                recentlyCompleted={recentlyCompletedIds?.has(conv.id)}
              />
            ))}
          </>
        ) : (
          <>
            {convs.length === 0 && folders.length === 0 && (
              <p className="px-3 py-4 text-[12px] text-faint">No conversations yet.</p>
            )}

            {/* One collapsible section per folder. */}
            {folders.map((folder) => (
              <FolderSection
                key={folder.id}
                folder={folder}
                items={byFolder.get(folder.id) ?? []}
                open={openFolders.has(folder.id)}
                onToggle={() => toggleFolder(folder.id)}
                onRequestDelete={() => setPendingFolderDelete(folder)}
                activeId={activeId}
                folders={folders}
                onSelect={onSelect}
                onDelete={onDelete}
                onMove={onMove}
                generatingIds={generatingIds}
                recentlyCompletedIds={recentlyCompletedIds}
              />
            ))}

            {/* Explicit "Uncategorized" label so it reads as its own section rather than
                blending into whichever folder happens to render above it — only shown
                once folders exist at all (a flat list with no folders needs no label). */}
            {folders.length > 0 && ungrouped.length > 0 && (
              <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                Uncategorized
              </div>
            )}
            {ungrouped.map((conv) => (
              <ConvItem
                key={conv.id}
                conv={conv}
                active={conv.id === activeId}
                folders={folders}
                onSelect={onSelect}
                onDelete={onDelete}
                onMove={onMove}
                generating={generatingIds?.has(conv.id)}
                recentlyCompleted={recentlyCompletedIds?.has(conv.id)}
              />
            ))}
          </>
        )}
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

      {/* Folder-delete confirmation. Folders can contain conversations, so always confirm. */}
      <AlertDialog open={!!pendingFolderDelete} onOpenChange={(open) => { if (!open) setPendingFolderDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this folder?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingFolderDelete ? (
                <>
                  <span className="font-medium text-ink">{pendingFolderDelete.name}</span>{' '}
                  will be deleted. Conversations inside it won’t be deleted — they’ll move back to
                  Uncategorized.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingFolderDelete) doDeleteFolder(pendingFolderDelete); setPendingFolderDelete(null) }}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** A single collapsible folder section: header (chevron + name + count + actions
 *  dropdown) plus its member conversations. Rename is done inline, mirroring ConvItem's
 *  double-click / Enter-to-commit UX. Delete is confirmed by the parent via AlertDialog. */
function FolderSection({
  folder,
  items,
  open,
  onToggle,
  onRequestDelete,
  activeId,
  folders,
  onSelect,
  onDelete,
  onMove,
  generatingIds,
  recentlyCompletedIds,
}: {
  folder: Folder
  items: Conversation[]
  open: boolean
  onToggle: () => void
  onRequestDelete: () => void
  activeId: string | null
  folders: Folder[]
  onSelect: (id: string) => void
  onDelete: (e: React.MouseEvent, conv: Conversation) => void
  onMove: (conv: Conversation, folderId: string | null) => void
  generatingIds?: Set<string>
  recentlyCompletedIds?: Set<string>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(folder.name)
  const mut = useConversationMutations()

  const commitRename = () => {
    setEditing(false)
    const name = draft.trim()
    if (!name || name === folder.name) { setDraft(folder.name); return }
    mut.renameFolder.mutate(
      { id: folder.id, name },
      { onError: () => { setDraft(folder.name); toast.error('Could not rename folder.') } },
    )
  }

  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <div className="group/folder relative flex items-center rounded-md pr-1">
        {editing ? (
          <div className="flex flex-1 items-center gap-1.5 px-2 py-1.5">
            <FolderIcon size={13} className="shrink-0 text-faint" />
            <input
              autoFocus
              className="w-full bg-transparent text-[12px] font-semibold text-ink outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setDraft(folder.name); setEditing(false) } }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : (
          <CollapsibleTrigger className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-semibold text-ink transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]">
            <ChevronDown size={13} className={`shrink-0 text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
            <FolderIcon size={13} className="shrink-0 text-faint" />
            <span className="truncate" onDoubleClick={(e) => { e.stopPropagation(); setDraft(folder.name); setEditing(true) }}>{folder.name}</span>
            <span className="ml-auto pl-1 text-[11px] font-normal text-faint">{items.length}</span>
          </CollapsibleTrigger>
        )}
        {!editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-faint opacity-0 transition-opacity hover:text-ink group-hover/folder:opacity-100 data-[state=open]:opacity-100"
                title="Folder actions"
              >
                <MoreHorizontal size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => { setDraft(folder.name); setEditing(true) }}>
                <Pencil size={13} /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={onRequestDelete}>
                <Trash2 size={13} /> Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <CollapsibleContent>
        {/* Left guide line brackets exactly which rows belong to this folder — a plain
            padding indent alone was too subtle to tell folder contents from the flat
            ungrouped list below. */}
        <div className="ml-3 border-l border-border pl-2">
          {items.length === 0 ? (
            <p className="px-3 py-1.5 text-[11px] text-faint">Empty folder</p>
          ) : (
            items.map((conv) => (
              <ConvItem
                key={conv.id}
                conv={conv}
                active={conv.id === activeId}
                folders={folders}
                onSelect={onSelect}
                onDelete={onDelete}
                onMove={onMove}
                generating={generatingIds?.has(conv.id)}
                recentlyCompleted={recentlyCompletedIds?.has(conv.id)}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ConvItem({
  conv,
  active,
  folders,
  onSelect,
  onDelete,
  onMove,
  generating,
  recentlyCompleted,
}: {
  conv: Conversation
  active: boolean
  folders: Folder[]
  onSelect: (id: string) => void
  onDelete: (e: React.MouseEvent, conv: Conversation) => void
  onMove: (conv: Conversation, folderId: string | null) => void
  /** True while this conversation is streaming a generation (foreground or background). */
  generating?: boolean
  /** True when this conversation's generation finished while the user was elsewhere. */
  recentlyCompleted?: boolean
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
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="min-w-0 truncate text-[13px] font-medium text-ink"
            style={{ color: active ? 'var(--accent)' : undefined }}
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
          >
            {conv.title}
          </span>
          {generating && (
            <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} aria-label="Generating" />
          )}
          {!generating && recentlyCompleted && (
            <Circle size={7} className="shrink-0 fill-current text-accent" aria-label="New reply" />
          )}
        </div>
      )}
      <span className="text-[11px] text-faint">{relTime(conv.updatedAt)}</span>
      {!editing && (
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-faint transition-colors hover:text-ink data-[state=open]:text-ink"
                title="Move to folder"
              >
                <FolderInput size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {folders.length === 0 && (
                <DropdownMenuItem disabled>No folders yet</DropdownMenuItem>
              )}
              {folders.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  disabled={f.id === conv.folderId}
                  onSelect={() => onMove(conv, f.id)}
                >
                  <FolderIcon size={13} /> {f.name}
                </DropdownMenuItem>
              ))}
              {conv.folderId && (
                <>
                  {folders.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => onMove(conv, null)}>
                    Uncategorized
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
