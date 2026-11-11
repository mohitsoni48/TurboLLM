import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { MicError, VoiceRecorder, clipDataUrl, micSupport, type RecorderOptions, type VoiceClip } from '../../lib/voice/recorder'
import { transcribeClip, warmVoice, type TranscribeResult } from '../../lib/voice/voice-api'
import { useVoiceStore } from '../../stores/voice'
import { useVoiceInput, type VoiceInputOptions } from './useVoiceInput'

vi.mock('../../lib/voice/recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/voice/recorder')>()),
  VoiceRecorder: { start: vi.fn() },
  micSupport: vi.fn(),
  clipDataUrl: vi.fn(),
}))
vi.mock('../../lib/voice/voice-api', () => ({ transcribeClip: vi.fn(), warmVoice: vi.fn(), getVoiceStatus: vi.fn() }))

const stt = vi.hoisted(() => ({ available: false }))
vi.mock('../../lib/voice/voice-queries', () => ({
  useVoiceStatus: () => ({ data: { stt: { available: stt.available } } }),
}))

const start = vi.mocked(VoiceRecorder.start)
const transcribe = vi.mocked(transcribeClip)

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const said = (text: string): TranscribeResult => ({ text, tookMs: 5 })

const clip = (durationMs = 2000): VoiceClip => ({ blob: new Blob(['wav'], { type: 'audio/wav' }), durationMs })

/** A recorder as VoiceRecorder.start hands it back. */
function fakeRecorder(result: VoiceClip = clip()) {
  return { stop: vi.fn(async () => result), cancel: vi.fn() } as unknown as VoiceRecorder & { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
}

const onText = vi.fn()
const onClip = vi.fn()
const notify = vi.fn()

function mount(modelHears: boolean) {
  const qc = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const initial: VoiceInputOptions = { modelHears, onText, onClip, notify }
  return renderHook((props: VoiceInputOptions) => useVoiceInput(props), { wrapper, initialProps: initial })
}

type Hook = ReturnType<typeof mount>

/** Presses the button and lets the (fake) microphone open. */
async function begin(hook: Hook, recorder = fakeRecorder()) {
  start.mockResolvedValueOnce(recorder)
  await act(async () => { await hook.result.current.start() })
  return recorder
}
const finish = (hook: Hook) => act(async () => { await hook.result.current.stop() })
/** The options the hook gave VoiceRecorder.start, for the recorder's own callbacks. */
const recorderOptions = (): RecorderOptions => start.mock.calls.at(-1)![0] as RecorderOptions

beforeEach(() => {
  vi.clearAllMocks()
  start.mockReset()
  transcribe.mockReset()
  vi.mocked(micSupport).mockReturnValue('ok')
  vi.mocked(clipDataUrl).mockResolvedValue('data:audio/wav;base64,AAAA')
  stt.available = false
  useVoiceStore.setState({ audioMode: 'ask', autoStop: true, autoSend: false })
})

describe('useVoiceInput block', () => {
  it('is the secure-page message when the browser withholds the microphone', () => {
    vi.mocked(micSupport).mockReturnValue('insecure')
    const { result } = mount(true)
    expect(result.current.block).toMatchObject({ kind: 'insecure' })
    expect(result.current.block?.message).toContain('secure page')
  })

  it('is the unsupported message when the browser cannot record', () => {
    vi.mocked(micSupport).mockReturnValue('unsupported')
    expect(mount(true).result.current.block).toMatchObject({ kind: 'unsupported', message: 'This browser cannot record audio.' })
  })

  it('is the setup message when neither the model nor speech-to-text can take a recording', () => {
    expect(mount(false).result.current.block).toMatchObject({ kind: 'setup' })
    expect(mount(false).result.current.block?.message).toContain('Settings → Voice')
  })

  it('is null when the model hears, or when speech-to-text is available', () => {
    expect(mount(true).result.current.block).toBeNull()
    stt.available = true
    expect(mount(false).result.current.block).toBeNull()
  })

  it('puts a browser problem before a missing setup', () => {
    vi.mocked(micSupport).mockReturnValue('insecure')
    expect(mount(false).result.current.block?.kind).toBe('insecure')
  })
})

describe('useVoiceInput start', () => {
  it('goes idle, then starting while the microphone opens, then recording', async () => {
    const hook = mount(true)
    const opening = deferred<VoiceRecorder>()
    start.mockReturnValueOnce(opening.promise)
    expect(hook.result.current.phase).toBe('idle')
    let pressed!: Promise<void>
    act(() => { pressed = hook.result.current.start() })
    expect(hook.result.current.phase).toBe('starting')
    await act(async () => { opening.resolve(fakeRecorder()); await pressed })
    expect(hook.result.current.phase).toBe('recording')
    expect(hook.result.current.startedAt).toBeGreaterThan(0)
  })

  it('opens the recorder with the saved auto-stop choice', async () => {
    useVoiceStore.setState({ autoStop: false })
    const hook = mount(true)
    await begin(hook)
    expect(recorderOptions().autoStop).toBe(false)
  })

  it('ignores a second press while it is busy', async () => {
    const hook = mount(true)
    await begin(hook)
    await act(async () => { await hook.result.current.start() })
    expect(start).toHaveBeenCalledTimes(1)
  })

  describe('warming whisper', () => {
    it('warms it when the clip may be transcribed', async () => {
      stt.available = true
      await begin(mount(false))
      expect(warmVoice).toHaveBeenCalledTimes(1)
    })

    it('warms it when the model hears but the mode is "ask" or "text"', async () => {
      stt.available = true
      await begin(mount(true))
      useVoiceStore.setState({ audioMode: 'text' })
      await begin(mount(true))
      expect(warmVoice).toHaveBeenCalledTimes(2)
    })

    it('does not warm it when the model hears and the mode is "audio"', async () => {
      stt.available = true
      useVoiceStore.setState({ audioMode: 'audio' })
      await begin(mount(true))
      expect(warmVoice).not.toHaveBeenCalled()
    })

    it('does not warm it without speech-to-text', async () => {
      await begin(mount(true))
      expect(warmVoice).not.toHaveBeenCalled()
    })
  })

  it('tells the user a MicError\'s message and goes back to idle', async () => {
    const hook = mount(true)
    start.mockRejectedValueOnce(new MicError('denied', 'Microphone access was denied.'))
    await act(async () => { await hook.result.current.start() })
    expect(notify).toHaveBeenCalledWith('Microphone access was denied.', 'error')
    expect(hook.result.current.phase).toBe('idle')
  })

  it('says something plain for any other failure', async () => {
    const hook = mount(true)
    start.mockRejectedValueOnce(new Error('weird'))
    await act(async () => { await hook.result.current.start() })
    expect(notify).toHaveBeenCalledWith('The microphone could not be opened.', 'error')
    expect(hook.result.current.phase).toBe('idle')
  })

  it('reports the input level through the meter, which the bar subscribes to, and zeroes it at the end', async () => {
    const hook = mount(true)
    const recorder = await begin(hook)
    const listener = vi.fn()
    hook.result.current.meter.subscribe(listener)
    act(() => recorderOptions().onLevel?.(0.6))
    expect(hook.result.current.meter.level()).toBe(0.6)
    expect(listener).toHaveBeenCalled()
    act(() => hook.result.current.cancel())
    expect(recorder.cancel).toHaveBeenCalled()
    expect(hook.result.current.meter.level()).toBe(0)
  })
})

describe('useVoiceInput stop', () => {
  it('with speech-to-text only: transcribes, hands over the text and goes idle', async () => {
    stt.available = true
    const hook = mount(false)
    const result = deferred<TranscribeResult>()
    transcribe.mockReturnValueOnce(result.promise)
    await begin(hook)
    await finish(hook)
    expect(hook.result.current.phase).toBe('transcribing')
    await act(async () => { result.resolve(said('hello there')) })
    expect(onText).toHaveBeenCalledWith('hello there')
    expect(onClip).not.toHaveBeenCalled()
    expect(hook.result.current.phase).toBe('idle')
  })

  it('sends the recording itself to the transcription', async () => {
    stt.available = true
    const hook = mount(false)
    transcribe.mockResolvedValueOnce(said('x'))
    const recorded = clip(1500)
    await begin(hook, fakeRecorder(recorded))
    await finish(hook)
    expect(transcribe.mock.calls[0][0]).toBe(recorded.blob)
  })

  it('an empty transcript is an info notice and no text', async () => {
    stt.available = true
    const hook = mount(false)
    transcribe.mockResolvedValueOnce(said(''))
    await begin(hook)
    await finish(hook)
    expect(notify).toHaveBeenCalledWith('No speech was recognised in that recording.', 'info')
    expect(onText).not.toHaveBeenCalled()
    expect(hook.result.current.phase).toBe('idle')
  })

  it('a transcription ApiError is an error notice with its message', async () => {
    stt.available = true
    const hook = mount(false)
    transcribe.mockRejectedValueOnce(new ApiError('stt_failed', 'whisper crashed', 500))
    await begin(hook)
    await finish(hook)
    expect(notify).toHaveBeenCalledWith('whisper crashed', 'error')
    expect(hook.result.current.phase).toBe('idle')
  })

  it('any other transcription failure gets a plain message', async () => {
    stt.available = true
    const hook = mount(false)
    transcribe.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await begin(hook)
    await finish(hook)
    expect(notify).toHaveBeenCalledWith('The recording could not be converted to text.', 'error')
  })

  it('with a model that hears only: attaches the clip as a wav File, with its data URL and duration', async () => {
    const hook = mount(true)
    await begin(hook, fakeRecorder(clip(2500)))
    await finish(hook)
    expect(onClip).toHaveBeenCalledTimes(1)
    const attached = onClip.mock.calls[0][0] as { file: File; dataUrl: string; durationMs: number }
    expect(attached.file).toBeInstanceOf(File)
    expect(attached.file.type).toBe('audio/wav')
    expect(attached.file.name).toBe('voice-message.wav')
    expect(attached.dataUrl).toBe('data:audio/wav;base64,AAAA')
    expect(attached.durationMs).toBe(2500)
    expect(transcribe).not.toHaveBeenCalled()
    expect(hook.result.current.phase).toBe('idle')
  })

  it('tells the user when the recording cannot be read back for attaching', async () => {
    vi.mocked(clipDataUrl).mockRejectedValueOnce(new Error('read failed'))
    const hook = mount(true)
    await begin(hook)
    await finish(hook)
    expect(notify).toHaveBeenCalledWith('The recording could not be read.', 'error')
    expect(onClip).not.toHaveBeenCalled()
    expect(hook.result.current.phase).toBe('idle')
  })

  it('does nothing when nothing is being recorded', async () => {
    const hook = mount(true)
    await finish(hook)
    expect(hook.result.current.phase).toBe('idle')
    expect(onClip).not.toHaveBeenCalled()
  })

  it('drops a clip shorter than 400 ms with an info notice and nothing else', async () => {
    stt.available = true
    const hook = mount(true)
    await begin(hook, fakeRecorder(clip(399)))
    await finish(hook)
    expect(notify).toHaveBeenCalledWith('That was too short to hear anything.', 'info')
    expect(onClip).not.toHaveBeenCalled()
    expect(onText).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(hook.result.current.phase).toBe('idle')
  })

  it('keeps a clip of exactly 400 ms', async () => {
    const hook = mount(true)
    await begin(hook, fakeRecorder(clip(400)))
    await finish(hook)
    expect(onClip).toHaveBeenCalled()
  })

  it('says to set up speech-to-text when what could take the recording went away while it was made', async () => {
    stt.available = true
    const hook = mount(false)
    await begin(hook)
    stt.available = false
    hook.rerender({ modelHears: false, onText, onClip, notify })
    await finish(hook)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Settings → Voice'), 'error')
    expect(hook.result.current.phase).toBe('idle')
  })
})

describe('useVoiceInput with a model that hears and speech-to-text', () => {
  beforeEach(() => { stt.available = true })

  it('asks which way to go in mode "ask", with the clip\'s length', async () => {
    const hook = mount(true)
    await begin(hook, fakeRecorder(clip(3200)))
    await finish(hook)
    expect(hook.result.current.phase).toBe('choosing')
    expect(hook.result.current.pendingMs).toBe(3200)
    expect(onClip).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('choose("audio", false) attaches the clip and leaves the mode on "ask"', async () => {
    const hook = mount(true)
    await begin(hook)
    await finish(hook)
    await act(async () => { hook.result.current.choose('audio', false) })
    expect(onClip).toHaveBeenCalledTimes(1)
    expect(useVoiceStore.getState().audioMode).toBe('ask')
    expect(hook.result.current.phase).toBe('idle')
  })

  it('choose("text", true) transcribes it and saves the mode "text"', async () => {
    transcribe.mockResolvedValueOnce(said('typed words'))
    const hook = mount(true)
    await begin(hook)
    await finish(hook)
    await act(async () => { hook.result.current.choose('text', true) })
    expect(onText).toHaveBeenCalledWith('typed words')
    expect(useVoiceStore.getState().audioMode).toBe('text')
    expect(hook.result.current.phase).toBe('idle')
  })

  it('choose("audio", true) saves the mode "audio"', async () => {
    const hook = mount(true)
    await begin(hook)
    await finish(hook)
    await act(async () => { hook.result.current.choose('audio', true) })
    expect(useVoiceStore.getState().audioMode).toBe('audio')
  })

  it('choose does nothing when no recording waits for an answer', async () => {
    const hook = mount(true)
    await act(async () => { hook.result.current.choose('audio', true) })
    expect(onClip).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().audioMode).toBe('ask')
  })

  it('skips the question in mode "audio"', async () => {
    useVoiceStore.setState({ audioMode: 'audio' })
    const hook = mount(true)
    await begin(hook)
    await finish(hook)
    expect(onClip).toHaveBeenCalledTimes(1)
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('skips the question in mode "text"', async () => {
    useVoiceStore.setState({ audioMode: 'text' })
    transcribe.mockResolvedValueOnce(said('words'))
    const hook = mount(true)
    await begin(hook)
    await finish(hook)
    expect(onText).toHaveBeenCalledWith('words')
    expect(onClip).not.toHaveBeenCalled()
  })

  it('cancel() drops the clip that waits for an answer', async () => {
    const hook = mount(true)
    await begin(hook)
    await finish(hook)
    act(() => hook.result.current.cancel())
    expect(hook.result.current.phase).toBe('idle')
    await act(async () => { hook.result.current.choose('audio', false) })
    expect(onClip).not.toHaveBeenCalled()
  })
})

describe('useVoiceInput automatic stop', () => {
  it('"finished" ends the recording as stop() does', async () => {
    const hook = mount(true)
    const recorder = await begin(hook)
    await act(async () => { recorderOptions().onAutoStop?.('finished') })
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(onClip).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('"no-speech" cancels the recording and says so', async () => {
    const hook = mount(true)
    const recorder = await begin(hook)
    await act(async () => { recorderOptions().onAutoStop?.('no-speech') })
    expect(recorder.cancel).toHaveBeenCalledTimes(1)
    expect(recorder.stop).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('Nothing was heard, so the recording was dropped.', 'info')
    expect(onClip).not.toHaveBeenCalled()
    expect(hook.result.current.phase).toBe('idle')
  })

  it('"max-length" tells the user, then finishes like stop()', async () => {
    const hook = mount(true)
    const recorder = await begin(hook)
    await act(async () => { recorderOptions().onAutoStop?.('max-length') })
    expect(notify).toHaveBeenCalledWith('The recording reached its five-minute limit.', 'info')
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(onClip).toHaveBeenCalledTimes(1)
  })
})

describe('useVoiceInput cancel', () => {
  it('during recording calls the recorder\'s cancel and goes idle', async () => {
    const hook = mount(true)
    const recorder = await begin(hook)
    act(() => hook.result.current.cancel())
    expect(recorder.cancel).toHaveBeenCalledTimes(1)
    expect(hook.result.current.phase).toBe('idle')
  })

  it('during transcription aborts the request and ignores its late result', async () => {
    stt.available = true
    const hook = mount(false)
    const pending = deferred<TranscribeResult>()
    transcribe.mockReturnValueOnce(pending.promise)
    await begin(hook)
    await finish(hook)
    const signal = (transcribe.mock.calls[0][1] as { signal: AbortSignal }).signal
    expect(signal.aborted).toBe(false)
    act(() => hook.result.current.cancel())
    expect(signal.aborted).toBe(true)
    expect(hook.result.current.phase).toBe('idle')
    await act(async () => { pending.resolve(said('too late')) })
    expect(onText).not.toHaveBeenCalled()
    expect(hook.result.current.phase).toBe('idle')
  })

  it('during transcription gives no error notice for the abort that followed', async () => {
    stt.available = true
    const hook = mount(false)
    const pending = deferred<TranscribeResult>()
    transcribe.mockReturnValueOnce(pending.promise)
    await begin(hook)
    await finish(hook)
    act(() => hook.result.current.cancel())
    await act(async () => { pending.reject(new DOMException('aborted', 'AbortError')) })
    expect(notify).not.toHaveBeenCalled()
  })

  it('while still waiting for the microphone, cancels the recorder that arrives late', async () => {
    const hook = mount(true)
    const opening = deferred<VoiceRecorder>()
    start.mockReturnValueOnce(opening.promise)
    let pressed!: Promise<void>
    act(() => { pressed = hook.result.current.start() })
    act(() => hook.result.current.cancel())
    expect(hook.result.current.phase).toBe('idle')
    const late = fakeRecorder()
    await act(async () => { opening.resolve(late); await pressed })
    expect(late.cancel).toHaveBeenCalledTimes(1)
    expect(hook.result.current.phase).toBe('idle')
  })

  it('while still waiting for the microphone, says nothing about a refusal that arrives late', async () => {
    const hook = mount(true)
    const opening = deferred<VoiceRecorder>()
    start.mockReturnValueOnce(opening.promise)
    let pressed!: Promise<void>
    act(() => { pressed = hook.result.current.start() })
    act(() => hook.result.current.cancel())
    await act(async () => { opening.reject(new MicError('denied', 'no')); await pressed })
    expect(notify).not.toHaveBeenCalled()
  })

  it('a stop that arrives after cancel does not use the clip', async () => {
    const hook = mount(true)
    const recorder = fakeRecorder()
    const stopping = deferred<VoiceClip>()
    recorder.stop.mockReturnValueOnce(stopping.promise)
    await begin(hook, recorder)
    let finishing!: Promise<void>
    act(() => { finishing = hook.result.current.stop() })
    act(() => hook.result.current.cancel())
    await act(async () => { stopping.resolve(clip()); await finishing })
    expect(onClip).not.toHaveBeenCalled()
  })
})

describe('useVoiceInput unmount', () => {
  it('cancels a recording in progress, so the microphone is let go', async () => {
    const hook = mount(true)
    const recorder = await begin(hook)
    hook.unmount()
    expect(recorder.cancel).toHaveBeenCalledTimes(1)
  })

  it('aborts a transcription in progress', async () => {
    stt.available = true
    const hook = mount(false)
    transcribe.mockReturnValueOnce(new Promise(() => {}))
    await begin(hook)
    await finish(hook)
    const signal = (transcribe.mock.calls[0][1] as { signal: AbortSignal }).signal
    hook.unmount()
    expect(signal.aborted).toBe(true)
  })
})
