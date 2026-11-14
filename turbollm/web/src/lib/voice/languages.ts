// The spoken languages whisper takes, as `code -> English name`, for the language picker in Settings → Voice.
//
// This mirrors WHISPER_LANGUAGES in src/voice/whisper-catalog.ts: the web bundle can only import types from the
// daemon, not its code. src/voice/whisper-catalog.test.ts checks the two agree.

export const WHISPER_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
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

/** The picker's value for "detect it per recording". */
export const AUTO_LANGUAGE = 'auto'
