// Voice: speech-to-text through whisper.cpp (src/voice). Types only, shared with the web app (`@contract/voice`).
//
// Text-to-speech has no daemon side: the page speaks with the device's own voices (web/src/lib/voice/tts.ts), so
// nothing about it is here.

/** A whisper model: one from the catalog (voice/whisper-catalog.ts), or a ggml file the user put in the models
 *  folder themselves. */
export type SttModel = {
  /** What `speechToText.model` names: a catalog id (`base`, `large-v3-turbo-q5_0`) or, for a file that is not in the
   *  catalog, its file name. */
  id: string
  label: string
  /** Size of the download (the catalog's), or of the file on disk for one that is not in the catalog. */
  sizeBytes: number
  /** False for an English-only model (`*.en`). */
  multilingual: boolean
  /** One line on what it is good for. '' for a file that is not in the catalog. */
  note: string
  installed: boolean
  /** The model to start with on most machines. */
  recommended?: boolean
  /** A file found in the models folder that the catalog does not list. */
  custom?: boolean
}

/** Where the whisper-server binary a transcription runs on comes from. */
export type SttServerSource =
  /** The path saved in Settings. */
  | 'custom'
  /** Shipped inside the Android app. */
  | 'bundled'
  /** Installed by TurboLLM from whisper.cpp's own release (POST /api/v1/voice/server/install). */
  | 'managed'
  /** Found on this machine: Homebrew, a distro package, or a build on the PATH. */
  | 'system'

/** One download at a time: the whisper-server install, or a model. */
export type SttProgress = {
  phase: 'downloading' | 'extracting'
  /** 0..1 while downloading; -1 while its size is unknown or it is extracting. */
  pct: number
}

/** Why no whisper-server can be installed with one click here, so the page can say what to do instead. */
export type SttInstallHint =
  /** macOS: whisper.cpp publishes no macOS binary; Homebrew has it (`brew install whisper.cpp`). */
  | 'homebrew'
  /** The Android app runs only what it ships. */
  | 'android'
  /** No published binary for this machine: build whisper.cpp, then point Settings at its whisper-server. */
  | 'build'

export type SttStatus = {
  /** A recording can be transcribed now: a whisper-server and a model are both there. */
  available: boolean
  /** The whisper-server process. It starts on the first transcription and stops after a while unused. */
  state: 'stopped' | 'starting' | 'ready' | 'error'
  /** Why the last start or transcription failed, as a sentence. */
  error: string | null
  server: {
    source: SttServerSource | null
    /** The release a managed install came from (whisper.cpp tags them `b<number>`); '' otherwise. */
    version: string
    /** Whether POST /api/v1/voice/server/install can get one for this machine. */
    installable: boolean
    hint: SttInstallHint | null
    /** A path is saved in Settings but no file is there. */
    customMissing: boolean
    /** Whether `speechToText.gpu` can do anything here. False in the Android app unless it was built with its GPU
     *  server (a second, Vulkan build of whisper-server); true elsewhere, where the whisper-server found decides. */
    gpu: boolean
    /** Why the Android app's GPU server was given up on, as a sentence: it could not start, or stopped while
     *  transcribing, and the CPU one has been used since. null while it has not failed. */
    gpuError: string | null
    installing: SttProgress | null
    installError: string | null
  }
  /** The model transcriptions use: `speechToText.model` when it is installed, else the first installed one; '' when
   *  none is. */
  model: string
  models: SttModel[]
  /** The model download in flight, if any. */
  downloading: (SttProgress & { model: string }) | null
  /** The last model download that failed, until another starts. */
  downloadError: { model: string; message: string } | null
}

/** GET /api/v1/voice. Carries no file paths: a remote-access token that may chat may read it. */
export type VoiceStatus = {
  stt: SttStatus
}

/** POST /api/v1/voice/transcribe (multipart `file`, optional `language`). */
export type TranscribeResult = {
  /** The transcript, trimmed, on one line. '' when whisper heard no speech. */
  text: string
  /** Milliseconds whisper took, model load included when this call started it. */
  tookMs: number
}

/** Settings → Voice, the daemon's part (`speechToText` in GET/PATCH /api/v1/settings). */
export type SpeechToTextSettings = {
  /** The whisper model to use: an {@link SttModel} id. '' uses the first installed one. */
  model: string
  /** Spoken language as a whisper code (`en`, `de`, `pt`…) or `auto` to detect it per recording. */
  language: string
  /** A whisper-server binary to run instead of the one TurboLLM finds or installs. '' finds one. Host-only. */
  serverPath: string
  /** Let whisper use the GPU when its build can. Off by default: the chat model was fitted to the VRAM that is
   *  free, and a second model on the same card takes from it. */
  gpu: boolean
}
