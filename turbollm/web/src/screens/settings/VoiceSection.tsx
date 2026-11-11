// Settings → Voice: speech-to-text setup (whisper.cpp on the daemon), what a recording becomes, and reading replies
// aloud (the device's own voices). The daemon's part is `speechToText` in settings and the voice status; the rest are
// this browser's preferences (stores/voice.ts).
import { useState } from 'react'
import { ChevronRight, Trash2 } from 'lucide-react'
import type { SttModel, SttProgress } from '@contract/voice'
import { ApiError } from '../../lib/api'
import { useSettings } from '../../lib/queries'
import { useVoiceSetup, useVoiceStatus } from '../../lib/voice/voice-queries'
import { useSpeakingId, useTtsAvailable, useTtsVoices } from '../../lib/voice/use-tts'
import { speaker } from '../../lib/voice/tts'
import { AUTO_LANGUAGE, WHISPER_LANGUAGE_NAMES } from '../../lib/voice/languages'
import { TTS_RATE_MAX, TTS_RATE_MIN, useVoiceStore, type AudioMode, type ReadAloud } from '../../stores/voice'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { CopyButton } from '../../components/ui/copy-button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { toast } from '../../components/ui/sonner'

const CARD = 'rounded-lg border border-border bg-panel p-4'
const H2 = 'mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint'
const SELECT = 'max-w-full rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink outline-none disabled:opacity-60'
const ERR = { color: 'var(--err)' }

/** A download size: whole MB below 1 GB, GB with one decimal from there. */
export function formatSize(bytes: number): string {
  const GB = 1024 ** 3
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

function onError(e: unknown) {
  toast.error(e instanceof ApiError ? e.message : 'That did not work.')
}

/** The 4px bar of EngineProvisionBanner: indeterminate (full width) while the size is unknown. */
function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
      <div
        className={`h-full rounded-full transition-all ${pct < 0 ? 'animate-pulse' : ''}`}
        style={{ width: pct >= 0 ? `${Math.round(pct * 100)}%` : '100%', background: 'var(--accent)' }}
      />
    </div>
  )
}

function SelectRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border py-3 first:border-t-0">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-[14px] font-medium text-ink">{label}</div>
        {hint && <div className="text-[12px] text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function CheckRow({ title, description, checked, onChange, disabled }: {
  title: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 border-t border-border py-3">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">{title}</div>
        <div className="text-[12px] text-muted">{description}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)] disabled:opacity-60"
      />
    </label>
  )
}

function Slider({ label, value, min, max, step, onChange, fmt, disabled }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt: (v: number) => string; disabled?: boolean
}) {
  return (
    <div className="border-t border-border py-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[14px] font-medium text-ink">{label}</span>
        <span className="font-mono text-[12px] text-muted">{fmt(value)}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)] disabled:opacity-60"
      />
    </div>
  )
}

function Percent({ progress }: { progress: SttProgress }) {
  return progress.pct >= 0 ? <span className="font-mono text-[12px] text-muted">{Math.round(progress.pct * 100)}%</span> : null
}

function SpeechToText() {
  const voiceQ = useVoiceStatus()
  const stt = voiceQ.data?.stt
  const setup = useVoiceSetup()
  const { query: settingsQ, save } = useSettings()
  const saved = settingsQ.data?.speechToText
  const savedPath = saved?.serverPath ?? ''
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  const [binOpen, setBinOpen] = useState<boolean | null>(null)

  const languages = Object.entries(WHISPER_LANGUAGE_NAMES).sort((a, b) => a[1].localeCompare(b[1]))
  // The voice status is worked out from these settings (which model is in use, where whisper-server is), so a save
  // is followed by a fresh read of it: the choice shows as taken at once, not at the next poll.
  const patch = (speechToText: Record<string, unknown>) =>
    save.mutate({ speechToText }, { onError, onSuccess: () => { void voiceQ.refetch() } })

  let body: React.ReactNode
  if (voiceQ.isError) {
    body = <p className="text-[13px] text-muted">Speech-to-text cannot be set up from this device.</p>
  } else if (!stt) {
    body = <p className="text-[13px] text-muted">Loading…</p>
  } else {
    const { server } = stt
    const draft = pathDraft ?? savedPath
    const open = binOpen ?? (savedPath !== '' || server.customMissing)
    body = (
      <>
        <div className="border-t border-border py-3">
          <div className="text-[14px] font-medium text-ink">whisper.cpp</div>
          {server.installing ? (
            <div className="mt-1">
              <div className="flex items-center justify-between gap-2 text-[12px] text-muted">
                <span>{server.installing.phase === 'extracting' ? 'Unpacking…' : 'Downloading whisper.cpp…'}</span>
                <span className="flex items-center gap-2">
                  <Percent progress={server.installing} />
                  <Button size="sm" variant="ghost" onClick={() => setup.cancelInstall.mutate(undefined, { onError })}>Cancel</Button>
                </span>
              </div>
              <ProgressBar pct={server.installing.pct} />
            </div>
          ) : server.source === 'managed' ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
              <span>Installed by TurboLLM{server.version ? ` · build ${server.version}` : ''}</span>
              <Button size="sm" variant="outline" onClick={() => setup.removeServer.mutate(undefined, { onError })}>Remove</Button>
            </div>
          ) : server.source === 'system' ? (
            <div className="text-[12px] text-muted">Found on this machine</div>
          ) : server.source === 'bundled' ? (
            <div className="text-[12px] text-muted">Included with the app</div>
          ) : server.source === 'custom' ? (
            <div className="text-[12px] text-muted">Using the whisper-server set below</div>
          ) : server.installable ? (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
                <span>Not installed</span>
                <Button size="sm" onClick={() => setup.installServer.mutate(undefined, { onError })}>Install whisper.cpp</Button>
              </div>
              <div className="mt-1 text-[12px] text-faint">About 10 MB, from whisper.cpp&apos;s own release.</div>
            </div>
          ) : server.hint === 'homebrew' ? (
            <div className="text-[12px] text-muted">
              <p>whisper.cpp has no ready-made macOS build. Install it with Homebrew, and TurboLLM will find it:</p>
              <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-border bg-panel-2 px-2 py-1.5">
                <code className="min-w-0 break-all font-mono text-[12px] text-ink">brew install whisper.cpp</code>
                <CopyButton text="brew install whisper.cpp" screen="settings" />
              </div>
            </div>
          ) : server.hint === 'android' ? (
            <div className="text-[12px] text-muted">
              Speech-to-text is not part of the Android app yet. A model that hears audio can still take your voice messages as they are.
            </div>
          ) : server.hint === 'build' ? (
            <div className="text-[12px] text-muted">
              There is no ready-made build for this machine. Build whisper.cpp yourself, then set the path to its whisper-server below.
            </div>
          ) : (
            <div className="text-[12px] text-muted">Not installed</div>
          )}
          {server.installError && <div className="mt-1 text-[12px]" style={ERR}>{server.installError}</div>}
          {server.customMissing && <div className="mt-1 text-[12px]" style={ERR}>There is no file at the path set below.</div>}
        </div>

        <div className="border-t border-border py-3">
          <div className="text-[14px] font-medium text-ink">Model</div>
          <div className="mb-1 text-[12px] text-muted">Bigger models hear better and take longer. One is enough.</div>
          <ul>
            {stt.models.map((m) => (
              <ModelRow key={m.id} m={m} stt={stt} setup={setup} onPick={(id) => patch({ model: id })} />
            ))}
          </ul>
        </div>

        <SelectRow label="Language" hint="The language you speak. Auto-detect works for most; pick one if it guesses wrong.">
          <select
            aria-label="Spoken language"
            value={saved?.language ?? AUTO_LANGUAGE}
            onChange={(e) => patch({ language: e.target.value })}
            className={SELECT}
          >
            <option value={AUTO_LANGUAGE}>Auto-detect</option>
            {languages.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </SelectRow>

        <CheckRow
          title="Use the GPU"
          description="Faster with the larger models, but it takes video memory from the chat model. Leave off unless transcription feels slow."
          checked={saved?.gpu ?? false}
          onChange={(gpu) => patch({ gpu })}
        />

        <Collapsible open={open} onOpenChange={setBinOpen} className="border-t border-border py-3">
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <ChevronRight size={14} className="transition-transform group-data-[state=open]:rotate-90" />
            Use my own whisper-server
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                aria-label="Path to whisper-server"
                placeholder="/path/to/whisper-server"
                value={draft}
                onChange={(e) => setPathDraft(e.target.value)}
                className="min-w-0 flex-1 basis-56 rounded-md border border-border bg-bg px-2 py-1 font-mono text-[13px] text-ink outline-none"
              />
              <Button
                size="sm"
                disabled={draft.trim() === savedPath}
                onClick={() => {
                  patch({ serverPath: draft.trim() })
                  setPathDraft(null)
                }}
              >
                Save
              </Button>
            </div>
            <div className="mt-1 text-[12px] text-muted">Leave empty to let TurboLLM find or install one.</div>
          </CollapsibleContent>
        </Collapsible>

        {stt.error && <div className="border-t border-border pt-3 text-[12px]" style={ERR}>Last problem: {stt.error}</div>}
        {stt.state === 'starting' && <div className="border-t border-border pt-3 text-[12px] text-muted">Loading the speech model…</div>}
      </>
    )
  }

  return (
    <section className={CARD}>
      <h2 className={H2}>Speech to text</h2>
      <p className="mb-2 text-[13px] text-muted">
        Turns what you say into a message. It runs on this machine with whisper.cpp; your voice is not sent anywhere.
      </p>
      {body}
    </section>
  )
}

function ModelRow({ m, stt, setup, onPick }: {
  m: SttModel
  stt: NonNullable<ReturnType<typeof useVoiceStatus>['data']>['stt']
  setup: ReturnType<typeof useVoiceSetup>
  onPick: (id: string) => void
}) {
  const downloading = stt.downloading?.model === m.id ? stt.downloading : null
  const error = stt.downloadError?.model === m.id ? stt.downloadError.message : null
  // "English only" for a file of the user's own, which has no note to say so. A catalog model's name and note already do.
  const detail = [formatSize(m.sizeBytes), m.note, ...(m.custom && !m.multilingual ? ['English only'] : [])].filter(Boolean).join(' · ')
  return (
    <li className="border-t border-border py-2 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-ink">
            {m.label}
            {m.recommended && <Badge variant="accent" className="normal-case tracking-normal">Recommended</Badge>}
            {m.custom && <Badge className="normal-case tracking-normal">Your file</Badge>}
          </div>
          <div className="text-[12px] text-muted">{detail}</div>
        </div>
        <div className="flex items-center gap-2">
          {m.installed ? (
            <>
              <input
                type="radio"
                name="stt-model"
                aria-label={`Use ${m.label}`}
                checked={stt.model === m.id}
                onChange={() => onPick(m.id)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <Button size="iconSm" variant="ghost" aria-label={`Delete ${m.label}`} onClick={() => setup.deleteModel.mutate(m.id, { onError })}>
                <Trash2 size={14} />
              </Button>
            </>
          ) : downloading ? (
            <>
              <Percent progress={downloading} />
              <Button size="sm" variant="ghost" aria-label={`Cancel downloading ${m.label}`} onClick={() => setup.cancelDownload.mutate(m.id, { onError })}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              aria-label={`Download ${m.label}`}
              disabled={stt.downloading !== null}
              onClick={() => setup.downloadModel.mutate(m.id, { onError })}
            >
              Download
            </Button>
          )}
        </div>
      </div>
      {downloading && <ProgressBar pct={downloading.pct} />}
      {error && <div className="mt-1 text-[12px]" style={ERR}>{error}</div>}
    </li>
  )
}

function VoiceMessages() {
  const audioMode = useVoiceStore((s) => s.audioMode)
  const setAudioMode = useVoiceStore((s) => s.setAudioMode)
  const autoStop = useVoiceStore((s) => s.autoStop)
  const setAutoStop = useVoiceStore((s) => s.setAutoStop)
  const autoSend = useVoiceStore((s) => s.autoSend)
  const setAutoSend = useVoiceStore((s) => s.setAutoSend)
  return (
    <section className={CARD}>
      <h2 className={H2}>Voice messages</h2>
      <SelectRow
        label="When the model can hear audio"
        hint="Some models take a recording as it is and hear your voice. Converting it to text first gives a message you can read and edit, and uses fewer tokens."
      >
        <select aria-label="When the model can hear audio" value={audioMode} onChange={(e) => setAudioMode(e.target.value as AudioMode)} className={SELECT}>
          <option value="ask">Ask each time</option>
          <option value="audio">Send the recording as audio</option>
          <option value="text">Convert it to text</option>
        </select>
      </SelectRow>
      <CheckRow title="Stop recording when I stop talking" description="The recording ends by itself after a moment of silence." checked={autoStop} onChange={setAutoStop} />
      <CheckRow
        title="Send as soon as I finish"
        description="Skips the look before sending. Off, the words land in the message box for you to check."
        checked={autoSend}
        onChange={setAutoSend}
      />
    </section>
  )
}

const SAMPLE_ID = 'voice-sample'

function ReadAloudCard() {
  const available = useTtsAvailable()
  const voices = useTtsVoices()
  const speakingId = useSpeakingId()
  const readAloud = useVoiceStore((s) => s.readAloud)
  const setReadAloud = useVoiceStore((s) => s.setReadAloud)
  const ttsVoice = useVoiceStore((s) => s.ttsVoice)
  const setTtsVoice = useVoiceStore((s) => s.setTtsVoice)
  const ttsRate = useVoiceStore((s) => s.ttsRate)
  const setTtsRate = useVoiceStore((s) => s.setTtsRate)
  const off = !available
  const playing = speakingId === SAMPLE_ID
  const voiceValue = voices.some((v) => v.id === ttsVoice) ? ttsVoice : ''
  return (
    <section className={CARD}>
      <h2 className={H2}>Read aloud</h2>
      {off && (
        <p className="mb-2 text-[13px] text-muted">
          This device has no speech voice the browser can use, so replies cannot be read aloud here. On Linux, install speech-dispatcher with a voice; on Android, check that a text-to-speech engine is installed.
        </p>
      )}
      <SelectRow label="Read replies aloud" hint="The speaker button on a reply reads it at any time.">
        <select aria-label="Read replies aloud" disabled={off} value={readAloud} onChange={(e) => setReadAloud(e.target.value as ReadAloud)} className={SELECT}>
          <option value="off">Only when I ask</option>
          <option value="voice">Replies to my voice messages</option>
          <option value="always">Every reply</option>
        </select>
      </SelectRow>
      <SelectRow label="Voice">
        <select aria-label="Voice" disabled={off} value={voiceValue} onChange={(e) => setTtsVoice(e.target.value)} className={SELECT}>
          <option value="">Automatic</option>
          {voices.map((v) => <option key={v.id} value={v.id}>{`${v.name} (${v.lang})`}</option>)}
        </select>
      </SelectRow>
      <Slider label="Speed" min={TTS_RATE_MIN} max={TTS_RATE_MAX} step={0.1} value={ttsRate} onChange={setTtsRate} fmt={(v) => `${v.toFixed(1)}×`} disabled={off} />
      <div className="border-t border-border pt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={off}
          onClick={() =>
            playing ? speaker.stop() : speaker.speak(SAMPLE_ID, 'This is how replies will sound.', { voiceId: ttsVoice, rate: ttsRate })
          }
        >
          {playing ? 'Stop' : 'Play a sample'}
        </Button>
      </div>
    </section>
  )
}

export function VoiceSection() {
  return (
    <div className="space-y-4">
      <SpeechToText />
      <VoiceMessages />
      <ReadAloudCard />
    </div>
  )
}
