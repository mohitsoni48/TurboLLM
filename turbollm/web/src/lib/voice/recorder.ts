// The microphone, as a clip: start, watch the level, stop, get a WAV.
//
// Samples are taken straight from the audio graph (an AudioWorklet, or a ScriptProcessor where there is none) rather
// than from a MediaRecorder: a MediaRecorder hands back WebM/Opus or MP4, which neither whisper.cpp nor llama.cpp
// reads without ffmpeg, and which would have to be decoded again to resample. Raw samples go through pcm.ts as they
// arrive, so a five-minute recording is held as ten megabytes of 16 kHz audio, not sixty of 48 kHz floats.
//
// The page can only reach a microphone in a secure context: https, or the machine itself (localhost / 127.0.0.1). A
// phone opening the UI over plain http on the LAN has no `navigator.mediaDevices` at all; micSupport() says so, so
// the composer can explain it instead of offering a button that does nothing.
import { CLIP_SAMPLE_RATE, Downsampler, concatSamples, encodeWav, rms } from './pcm'
import { SilenceDetector, type SilenceOptions } from './silence'

export type MicSupport =
  | 'ok'
  /** The page was not loaded over https or from the machine itself, so the browser withholds the microphone. */
  | 'insecure'
  /** This browser has no microphone API, or no Web Audio. */
  | 'unsupported'

type AudioContextCtor = typeof AudioContext

function audioContextCtor(): AudioContextCtor | undefined {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  return w.AudioContext ?? w.webkitAudioContext
}

export function micSupport(): MicSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported'
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return window.isSecureContext === false ? 'insecure' : 'unsupported'
  return audioContextCtor() ? 'ok' : 'unsupported'
}

export type MicFailure =
  /** The user, the browser or the app shell said no. */
  | 'denied'
  | 'no-device'
  /** Another program holds the microphone, or the driver failed. */
  | 'busy'
  | 'failed'

export class MicError extends Error {
  constructor(readonly reason: MicFailure, message: string) {
    super(message)
    this.name = 'MicError'
  }
}

/** What the user is told when the microphone cannot be opened. */
export function micErrorFor(e: unknown): MicError {
  if (e instanceof MicError) return e
  const name = e instanceof Error ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new MicError('denied', 'Microphone access was denied. Allow it for this page in your browser or system settings, then try again.')
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new MicError('no-device', 'No microphone was found on this device.')
  if (name === 'NotReadableError' || name === 'AbortError') return new MicError('busy', 'The microphone could not be opened. Another app may be using it.')
  return new MicError('failed', `The microphone could not be opened${e instanceof Error && e.message ? `: ${e.message}` : '.'}`)
}

export interface VoiceClip {
  /** A mono 16-bit WAV. */
  blob: Blob
  durationMs: number
}

/** Why a recording ended without the user pressing stop. */
export type AutoStop =
  /** The speaker went quiet after speaking (silence.ts). */
  | 'finished'
  /** Nothing was said. */
  | 'no-speech'
  /** It reached the longest a voice message may be. */
  | 'max-length'

export interface RecorderOptions {
  /** End the recording by itself once the speaker has finished, or has said nothing for a while. */
  autoStop?: boolean
  silence?: SilenceOptions
  /** The longest recording, after which it ends by itself. */
  maxMs?: number
  /** The input level, 0 (silence) to 1, a couple of dozen times a second. */
  onLevel?: (level: number) => void
  /** The recording should end now, and why. Called once; the caller calls stop() or cancel(). */
  onAutoStop?: (why: AutoStop) => void
}

/** Five minutes: ten megabytes of WAV, and already far past a spoken message. */
export const MAX_RECORDING_MS = 5 * 60_000

/** Samples per message from the audio thread: about 43 ms at 48 kHz, which is how often the level updates. */
const CAPTURE_CHUNK = 2048

// Runs on the audio thread. It only collects: a block of input, mixed to mono, posted to the page once CAPTURE_CHUNK
// samples are in. Kept as a string because a worklet module is loaded by URL and this way it needs no file of its own.
const CAPTURE_WORKLET = `
class TurboLLMCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(${CAPTURE_CHUNK})
    this.fill = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const frames = input[0].length
    for (let i = 0; i < frames; i++) {
      let sample = 0
      for (let c = 0; c < input.length; c++) sample += input[c][i]
      this.buffer[this.fill++] = sample / input.length
      if (this.fill === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(${CAPTURE_CHUNK})
        this.fill = 0
      }
    }
    return true
  }
}
registerProcessor('turbollm-capture', TurboLLMCapture)
`

export class VoiceRecorder {
  private readonly downsampler: Downsampler
  private readonly detector: SilenceDetector | null
  private readonly clipRate: number
  private readonly maxMs: number
  private chunks: Float32Array[] = []
  private capturedSamples = 0
  private node: AudioNode | null = null
  private ended = false
  private autoStopped = false

  private constructor(
    private readonly stream: MediaStream,
    private readonly ctx: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly opts: RecorderOptions,
  ) {
    this.clipRate = Math.min(CLIP_SAMPLE_RATE, ctx.sampleRate)
    this.downsampler = new Downsampler(ctx.sampleRate, this.clipRate)
    this.detector = opts.autoStop ? new SilenceDetector(ctx.sampleRate, opts.silence) : null
    this.maxMs = opts.maxMs ?? MAX_RECORDING_MS
  }

  /** Ask for the microphone and start recording. Rejects with a {@link MicError}. Call it from a click or a key
   *  press: a browser will not prompt for the microphone, or start audio, without one. */
  static async start(opts: RecorderOptions = {}): Promise<VoiceRecorder> {
    const Ctx = audioContextCtor()
    if (!Ctx || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      throw new MicError('failed', 'This browser cannot record audio.')
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (e) {
      throw micErrorFor(e)
    }
    let ctx: AudioContext | null = null
    try {
      ctx = new Ctx()
      if (ctx.state === 'suspended') await ctx.resume()
      const recorder = new VoiceRecorder(stream, ctx, ctx.createMediaStreamSource(stream), opts)
      await recorder.connect()
      return recorder
    } catch (e) {
      for (const track of stream.getTracks()) track.stop()
      void ctx?.close().catch(() => {})
      throw micErrorFor(e)
    }
  }

  /** How much has been recorded. */
  elapsedMs(): number {
    return (this.capturedSamples / this.ctx.sampleRate) * 1000
  }

  /** End the recording and return it. */
  async stop(): Promise<VoiceClip> {
    const durationMs = this.elapsedMs()
    this.release()
    const samples = concatSamples(this.chunks)
    this.chunks = []
    const wav = encodeWav(samples, this.clipRate)
    return { blob: new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), durationMs }
  }

  /** End the recording and throw it away. */
  cancel(): void {
    this.release()
    this.chunks = []
  }

  private async connect(): Promise<void> {
    // Through a silent gain into the output: a node nothing pulls from is not run at all in some browsers, and
    // without the mute the user would hear their own microphone.
    const mute = this.ctx.createGain()
    mute.gain.value = 0
    mute.connect(this.ctx.destination)
    const node = (await this.workletNode()) ?? this.scriptNode()
    this.source.connect(node)
    node.connect(mute)
    this.node = node
  }

  private async workletNode(): Promise<AudioNode | null> {
    if (!this.ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return null
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }))
    try {
      await this.ctx.audioWorklet.addModule(url)
      const node = new AudioWorkletNode(this.ctx, 'turbollm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.take(e.data)
      return node
    } catch {
      return null // a page policy that forbids blob: scripts: fall back to the ScriptProcessor
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** The deprecated ancestor of the worklet, still in every browser: it runs on the page's own thread, which is fine
   *  for collecting samples. */
  private scriptNode(): AudioNode {
    const node = this.ctx.createScriptProcessor(CAPTURE_CHUNK, 1, 1)
    node.onaudioprocess = (e) => this.take(new Float32Array(e.inputBuffer.getChannelData(0)))
    return node
  }

  private take(samples: Float32Array): void {
    if (this.ended) return
    this.capturedSamples += samples.length
    this.chunks.push(new Float32Array(this.downsampler.push(samples)))
    this.opts.onLevel?.(Math.min(1, rms(samples) * 4)) // speech sits around 0.05–0.25 RMS: scaled so the meter moves
    if (this.autoStopped) return
    const hearing = this.detector?.push(samples)
    const why: AutoStop | null = hearing === 'finished' ? 'finished'
      : hearing === 'no-speech' ? 'no-speech'
        : this.elapsedMs() >= this.maxMs ? 'max-length' : null
    if (why) {
      this.autoStopped = true
      this.opts.onAutoStop?.(why)
    }
  }

  private release(): void {
    if (this.ended) return
    this.ended = true
    try { this.source.disconnect() } catch { /* already disconnected */ }
    try { this.node?.disconnect() } catch { /* already disconnected */ }
    if (typeof AudioWorkletNode !== 'undefined' && this.node instanceof AudioWorkletNode) this.node.port.onmessage = null
    // Stopping the tracks is what turns the browser's recording indicator off.
    for (const track of this.stream.getTracks()) track.stop()
    void this.ctx.close().catch(() => {})
  }
}

/** A clip as the `data:audio/wav;base64,…` URL a chat message carries it as. */
export function clipDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the recording.'))
    reader.readAsDataURL(blob)
  })
}
