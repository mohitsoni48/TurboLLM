// The speaker (tts.ts) for components: what is being read, what can be, and telling the user when a reply is in a
// language this device has no voice for.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from '../../components/ui/sonner'
import { useVoiceStore } from '../../stores/voice'
import { languageName } from './language'
import { onTtsVoices, speaker, ttsAllVoices, ttsAvailable, ttsVoiceInstaller, type MissingVoice, type SpeakOptions, type TtsVoice } from './tts'

/** Whether this device can speak. Voices arrive late in some browsers, so this follows the list as it changes. */
export function useTtsAvailable(): boolean {
  return useSyncExternalStore(onTtsVoices, ttsAvailable, () => false)
}

let voicesSnapshot: TtsVoice[] = []
let voicesKey = ''

/** A stable array while the list is unchanged: useSyncExternalStore re-renders on every new reference. */
function voicesSnapshotNow(): TtsVoice[] {
  const now = ttsAllVoices()
  const key = now.map((v) => `${v.id}\t${v.lang}\t${v.local ? 1 : 0}`).join('\n')
  if (key !== voicesKey) {
    voicesKey = key
    voicesSnapshot = now
  }
  return voicesSnapshot
}

const NO_VOICES: TtsVoice[] = []

/** Every voice the device lists, the online ones included (voice-choice.ts says which may be used). */
export function useAllTtsVoices(): TtsVoice[] {
  return useSyncExternalStore(onTtsVoices, voicesSnapshotNow, () => NO_VOICES)
}

/** The id of the message being read aloud, or null. */
export function useSpeakingId(): string | null {
  return useSyncExternalStore(speaker.subscribe, speaker.activeId, () => null)
}

/** How the user has asked replies to be read, as the speaker takes it. */
export function readAloudOptions(): SpeakOptions {
  const { ttsVoice, ttsRate, onlineVoices } = useVoiceStore.getState()
  return { voiceId: ttsVoice, rate: ttsRate, allowOnline: onlineVoices }
}

/** Read a message aloud, or stop if it is the one being read. */
export function useReadAloud(): { speakingId: string | null; toggle: (id: string, markdown: string) => void; stop: () => void } {
  const speakingId = useSpeakingId()
  const toggle = useCallback((id: string, markdown: string) => {
    if (speaker.activeId() === id) {
      speaker.stop()
      return
    }
    speaker.speak(id, markdown, readAloudOptions())
  }, [])
  const stop = useCallback(() => speaker.stop(), [])
  return { speakingId, toggle, stop }
}

/** PURE: what to tell the user when a reply is in a language no voice here speaks. */
export function missingVoiceNotice(missing: MissingVoice, canInstall: boolean): { title: string; description: string } {
  const language = languageName(missing.language)
  // The stand-in is named by its language, not its name: a phone's voices are called things like
  // "en-us-x-sfg-local".
  const voice = missing.stoodIn?.lang ? `the ${languageName(missing.stoodIn.lang)} voice` : 'the voice this device has'
  const read = !missing.stoodIn
    ? 'It cannot be read aloud here.'
    : missing.skipped
      ? `${voice[0].toUpperCase()}${voice.slice(1)} cannot read it, so it is left out.`
      : `It is being read by ${voice}.`
  const add = canInstall
    ? `Add a ${language} voice in your phone's text-to-speech settings`
    : `Add a ${language} voice in your system's speech settings`
  const online = missing.onlineOnly ? ', or allow online voices in Settings → Voice' : ''
  return { title: `This device has no ${language} voice`, description: `${read} ${add}${online}.` }
}

/** Says so, once per language, when something is read in a language this device has no voice for: otherwise the
 *  wrong accent (or the silence) looks like the feature only knowing one language. Mounted once, for the app's
 *  lifetime: replies are read from the chat, and the sample from Settings. */
export function useVoiceNotices(): void {
  const navigate = useNavigate()
  useEffect(() => speaker.onVoiceMissing((missing) => {
    const install = ttsVoiceInstaller()
    const { title, description } = missingVoiceNotice(missing, install !== null)
    toast(title, {
      // One notice per language: said again, it takes the place of the last one instead of stacking under it.
      id: `voice-missing-${missing.language}`,
      description,
      duration: 12_000,
      action: install
        ? { label: 'Get voices', onClick: install }
        : { label: 'Voice settings', onClick: () => navigate('/settings?section=voice') },
    })
  }), [navigate])
}
