// The daemon's voice status as a query, and the setup mutations of Settings → Voice.
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { pollWhileLive } from '../live-events'
import {
  cancelWhisperModelDownload, cancelWhisperServerInstall, deleteWhisperModel, downloadWhisperModel, getVoiceStatus,
  installWhisperServer, removeWhisperServer, type VoiceStatus,
} from './voice-api'

/** The invalidation stream announces changes under the `voice` key (live-events.ts FAMILY_TARGETS). */
export const voiceKeys = { status: ['voice'] as const }

/** Whether something in the status moves on its own: a download or install counting up, or whisper loading. */
export function voiceInProgress(status: VoiceStatus | undefined): boolean {
  const stt = status?.stt
  return !!stt && (stt.downloading !== null || stt.server.installing !== null || stt.state === 'starting')
}

/** Polled every second while something is in progress; otherwise left to the invalidation stream, with a slow poll
 *  as its safety net. An older daemon answers 404: speech-to-text is then simply not there, so it is not retried. */
export function useVoiceStatus(): UseQueryResult<VoiceStatus> {
  return useQuery({
    queryKey: voiceKeys.status,
    queryFn: getVoiceStatus,
    refetchInterval: (q) => (voiceInProgress(q.state.data) ? 1000 : pollWhileLive(15_000, 60_000)),
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    retry: false,
  })
}

/** Each call answers with the new status, which is put straight into the cache. */
export function useVoiceSetup() {
  const qc = useQueryClient()
  const adopt = (status: VoiceStatus) => qc.setQueryData(voiceKeys.status, status)
  return {
    installServer: useMutation({ mutationFn: installWhisperServer, onSuccess: adopt }),
    cancelInstall: useMutation({ mutationFn: cancelWhisperServerInstall, onSuccess: adopt }),
    removeServer: useMutation({ mutationFn: removeWhisperServer, onSuccess: adopt }),
    downloadModel: useMutation({ mutationFn: downloadWhisperModel, onSuccess: adopt }),
    cancelDownload: useMutation({ mutationFn: cancelWhisperModelDownload, onSuccess: adopt }),
    deleteModel: useMutation({ mutationFn: deleteWhisperModel, onSuccess: adopt }),
  }
}
