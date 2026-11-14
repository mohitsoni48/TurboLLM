import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChatSession } from './chat-session'

/** Subscribes React to the chat's stream/reattach orchestration (chat-session.ts). `activeId` is the
 *  open chat; `runningReplyId` the reply the daemon says holds it and `convReadAt` when the chat
 *  was last read — together what the reattach follows. */
export function useChatSession({ activeId, runningReplyId, convReadAt, onActiveReplyDone }: {
  activeId: string | null
  runningReplyId: string | null
  convReadAt: number
  onActiveReplyDone: () => void
}) {
  const qc = useQueryClient()
  // Streams outlive the render that started them, so they read the CURRENT values through refs.
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const replyDoneRef = useRef(onActiveReplyDone)
  replyDoneRef.current = onActiveReplyDone
  const [session] = useState(() => new ChatSession({
    qc,
    getActiveId: () => activeIdRef.current,
    onActiveReplyDone: () => replyDoneRef.current(),
  }))
  const { liveByConv, recentlyCompletedIds } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const liveReplyId = activeId ? liveByConv[activeId]?.assistantId : undefined

  useEffect(() => {
    session.attach(activeId, runningReplyId, liveReplyId, convReadAt)
  }, [session, activeId, runningReplyId, liveReplyId, convReadAt])

  useEffect(() => {
    session.mount()
    return () => session.unmount()
  }, [session])

  return { session, liveByConv, recentlyCompletedIds }
}
