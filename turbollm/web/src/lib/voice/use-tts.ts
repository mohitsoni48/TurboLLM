// The speaker (tts.ts) for components: what is being read, and whether anything can be.
import { useCallback, useSyncExternalStore } from 'react'
import { useVoiceStore } from '../../stores/voice'
import { onTtsVoices, speaker, ttsAvailable, ttsVoices, type TtsVoice } from './tts'

/** Whether this device can speak. Voices arrive late in some browsers, so this follows the list as it changes. */
export function useTtsAvailable(): boolean {
  return useSyncExternalStore(onTtsVoices, ttsAvailable, () => false)
}

let voicesSnapshot: TtsVoice[] = []
let voicesKey = ''

/** A stable array while the list is unchanged: useSyncExternalStore re-renders on every new reference. */
function voicesSnapshotNow(): TtsVoice[] {
  const now = ttsVoices()
  const key = now.map((v) => v.id).join('\n')
  if (key !== voicesKey) {
    voicesKey = key
    voicesSnapshot = now
  }
  return voicesSnapshot
}

const NO_VOICES: TtsVoice[] = []

export function useTtsVoices(): TtsVoice[] {
  return useSyncExternalStore(onTtsVoices, voicesSnapshotNow, () => NO_VOICES)
}

/** The id of the message being read aloud, or null. */
export function useSpeakingId(): string | null {
  return useSyncExternalStore(speaker.subscribe, speaker.activeId, () => null)
}

/** Read a message aloud in the chosen voice, or stop if it is the one being read. */
export function useReadAloud(): { speakingId: string | null; toggle: (id: string, markdown: string) => void; stop: () => void } {
  const speakingId = useSpeakingId()
  const toggle = useCallback((id: string, markdown: string) => {
    if (speaker.activeId() === id) {
      speaker.stop()
      return
    }
    const { ttsVoice, ttsRate } = useVoiceStore.getState()
    speaker.speak(id, markdown, { voiceId: ttsVoice, rate: ttsRate })
  }, [])
  const stop = useCallback(() => speaker.stop(), [])
  return { speakingId, toggle, stop }
}
