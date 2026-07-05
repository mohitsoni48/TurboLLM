import { ChatScreen } from './ChatScreen'

// ── Workspace ─────────────────────────────────────────────────────────────────
//
// The "doing work / talking" surface. Used to be a Chat | Agent tab strip; the
// Agent tab is gone (there is no separate Agent surface anymore — skills live
// directly in Chat), so this is just Chat.

export function WorkspaceScreen() {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <ChatScreen />
      </div>
    </div>
  )
}
