// The whisper models TurboLLM offers to download, and the languages whisper knows.
//
// Models are whisper.cpp's own ggml conversions, from the Hugging Face repository its
// `models/download-ggml-model.sh` reads. Each entry's size and sha256 are that repository's (its LFS object id is the
// file's sha256), so a download is checked against the file this list was written from. The list is a selection: the
// repository has every size in three quantizations, and a picker of thirty near-identical rows helps nobody. A file
// that is not listed still works: put it in the models folder (whisper-paths.ts) and it is offered by its name.
//
// PURE: no I/O, so the routes, the service and the tests share it.

export const WHISPER_MODEL_REPO = 'ggerganov/whisper.cpp'

export interface WhisperCatalogModel {
  id: string
  label: string
  /** File name in the repository, and on disk. */
  file: string
  sizeBytes: number
  sha256: string
  multilingual: boolean
  note: string
  recommended?: boolean
}

export const WHISPER_MODELS: readonly WhisperCatalogModel[] = [
  {
    id: 'base', label: 'Base', file: 'ggml-base.bin', sizeBytes: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    multilingual: true, recommended: true,
    note: 'Quick on any CPU and accurate enough for dictation.',
  },
  {
    id: 'tiny', label: 'Tiny', file: 'ggml-tiny.bin', sizeBytes: 77691713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    multilingual: true,
    note: 'The fastest. Mishears more, especially names and accents.',
  },
  {
    id: 'base-q5_1', label: 'Base (compact)', file: 'ggml-base-q5_1.bin', sizeBytes: 59707625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    multilingual: true,
    note: 'Base at well under half the size, for a phone or a small disk.',
  },
  {
    id: 'small', label: 'Small', file: 'ggml-small.bin', sizeBytes: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    multilingual: true,
    note: 'Clearly more accurate than Base, and a few times slower.',
  },
  {
    id: 'small-q5_1', label: 'Small (compact)', file: 'ggml-small-q5_1.bin', sizeBytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    multilingual: true,
    note: 'Small at well under half the size.',
  },
  {
    id: 'large-v3-turbo-q5_0', label: 'Large v3 Turbo (compact)', file: 'ggml-large-v3-turbo-q5_0.bin', sizeBytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    multilingual: true,
    note: 'Near the best accuracy. Slow on a CPU alone; best with the GPU option on.',
  },
  {
    id: 'large-v3-turbo', label: 'Large v3 Turbo', file: 'ggml-large-v3-turbo.bin', sizeBytes: 1624555275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    multilingual: true,
    note: 'The most accurate here. Needs the GPU option to be comfortable.',
  },
  {
    id: 'tiny.en', label: 'Tiny, English only', file: 'ggml-tiny.en.bin', sizeBytes: 77704715,
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    multilingual: false,
    note: 'Tiny, a little better at English and nothing else.',
  },
  {
    id: 'base.en', label: 'Base, English only', file: 'ggml-base.en.bin', sizeBytes: 147964211,
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    multilingual: false,
    note: 'Base, a little better at English and nothing else.',
  },
  {
    id: 'small.en', label: 'Small, English only', file: 'ggml-small.en.bin', sizeBytes: 487614201,
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    multilingual: false,
    note: 'Small, a little better at English and nothing else.',
  },
]

export function whisperCatalogModel(id: string): WhisperCatalogModel | undefined {
  return WHISPER_MODELS.find((m) => m.id === id)
}

/** A ggml whisper model as a file name: what the models folder is scanned for, and the only shape a model id that is
 *  not in the catalog may have (so an id can never name a path outside that folder). */
export const WHISPER_MODEL_FILE = /^ggml-[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/

/** Whether a model file is English-only by whisper.cpp's naming (`ggml-base.en.bin`, `ggml-small.en-q5_1.bin`). */
export function isEnglishOnlyFile(file: string): boolean {
  return /\.en(-q\d+_\d+)?\.bin$/.test(file)
}

/** The language codes whisper accepts (whisper.cpp `g_lang`), code to English name. `auto` is not one of them: it is
 *  what whisper-server takes to detect the language per recording. */
export const WHISPER_LANGUAGES: Readonly<Record<string, string>> = {
  en: 'English', zh: 'Chinese', de: 'German', es: 'Spanish', ru: 'Russian', ko: 'Korean', fr: 'French', ja: 'Japanese',
  pt: 'Portuguese', tr: 'Turkish', pl: 'Polish', ca: 'Catalan', nl: 'Dutch', ar: 'Arabic', sv: 'Swedish', it: 'Italian',
  id: 'Indonesian', hi: 'Hindi', fi: 'Finnish', vi: 'Vietnamese', he: 'Hebrew', uk: 'Ukrainian', el: 'Greek', ms: 'Malay',
  cs: 'Czech', ro: 'Romanian', da: 'Danish', hu: 'Hungarian', ta: 'Tamil', no: 'Norwegian', th: 'Thai', ur: 'Urdu',
  hr: 'Croatian', bg: 'Bulgarian', lt: 'Lithuanian', la: 'Latin', mi: 'Maori', ml: 'Malayalam', cy: 'Welsh', sk: 'Slovak',
  te: 'Telugu', fa: 'Persian', lv: 'Latvian', bn: 'Bengali', sr: 'Serbian', az: 'Azerbaijani', sl: 'Slovenian',
  kn: 'Kannada', et: 'Estonian', mk: 'Macedonian', br: 'Breton', eu: 'Basque', is: 'Icelandic', hy: 'Armenian',
  ne: 'Nepali', mn: 'Mongolian', bs: 'Bosnian', kk: 'Kazakh', sq: 'Albanian', sw: 'Swahili', gl: 'Galician',
  mr: 'Marathi', pa: 'Punjabi', si: 'Sinhala', km: 'Khmer', sn: 'Shona', yo: 'Yoruba', so: 'Somali', af: 'Afrikaans',
  oc: 'Occitan', ka: 'Georgian', be: 'Belarusian', tg: 'Tajik', sd: 'Sindhi', gu: 'Gujarati', am: 'Amharic',
  yi: 'Yiddish', lo: 'Lao', uz: 'Uzbek', fo: 'Faroese', ht: 'Haitian Creole', ps: 'Pashto', tk: 'Turkmen',
  nn: 'Nynorsk', mt: 'Maltese', sa: 'Sanskrit', lb: 'Luxembourgish', my: 'Myanmar', bo: 'Tibetan', tl: 'Tagalog',
  mg: 'Malagasy', as: 'Assamese', tt: 'Tatar', haw: 'Hawaiian', ln: 'Lingala', ha: 'Hausa', ba: 'Bashkir',
  jw: 'Javanese', su: 'Sundanese', yue: 'Cantonese',
}

export const AUTO_LANGUAGE = 'auto'

/** A language whisper-server takes: `auto` or one of {@link WHISPER_LANGUAGES}. Anything else it rejects, and a wrong
 *  default language makes the server refuse to start at all. */
export function isWhisperLanguage(v: unknown): v is string {
  return typeof v === 'string' && knownLanguage(v)
}

function knownLanguage(code: string): boolean {
  return code === AUTO_LANGUAGE || Object.hasOwn(WHISPER_LANGUAGES, code)
}

/** A request's language as whisper takes it. OpenAI clients send ISO-639-1 (`en`), sometimes with a region (`en-US`)
 *  or in capitals; whisper's codes are the lower-case language part. Null when it names no language whisper knows. */
export function normalizeLanguage(raw: string): string | null {
  const v = raw.trim().toLowerCase()
  if (knownLanguage(v)) return v
  const base = v.split(/[-_]/)[0]
  return knownLanguage(base) ? base : null
}

/** A transcript as one line of text. whisper-server's `json` answer puts each segment on its own line with a leading
 *  space, and marks audio it heard nothing in as `[BLANK_AUDIO]`: neither belongs in a chat box. */
export function tidyTranscript(raw: string): string {
  return raw
    .replace(/\[BLANK_AUDIO\]/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
