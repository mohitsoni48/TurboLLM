// Which of the device's voices reads a piece of text.
//
// A voice speaks one language. Given another, it reads by its own spelling rules (an English voice makes "gracias"
// rhyme with "glacious") or, across scripts, says nothing at all. So the voice follows the text: a reply in Spanish is
// read by a Spanish voice, whatever language the browser is set to and whichever voice was picked for the user's own.
// That is the whole of "read aloud only works in English": the device had other voices, and the first one was used
// for everything.
//
// What a device can speak is what it has voices for, and that differs from one to the next: a Mac ships dozens, a
// Windows install the languages of its language packs, an Android phone whatever its speech engine has downloaded.
// When there is no voice for a language the text is still read, by the voice the user would otherwise hear, and the
// caller is told which language was missing so the user can be: a wrong accent with an explanation beats silence.
//
// PURE: voices in, a choice out. tts.ts owns the engines; this is shared by both of them.
import { primaryLanguage } from './language'

export interface TtsVoice {
  /** What the saved preference names. */
  id: string
  name: string
  /** BCP 47, e.g. `en-US`; '' when the engine does not say. */
  lang: string
  /** Synthesised on this device. A voice that is not sends the text to its maker's servers. */
  local: boolean
  /** The engine's own default voice. */
  isDefault?: boolean
}

export interface VoiceWish {
  /** The voice the user picked; '' for automatic. */
  voiceId: string
  /** The language of the text (a primary subtag, as detectLanguage gives), or null when it could not be told. */
  language: string | null
  /** Voices that speak through a server may be used, for a language no voice on the device speaks. */
  allowOnline: boolean
  /** The user's own languages, most wanted first (`navigator.languages`). */
  preferred: readonly string[]
}

export interface VoiceChoice {
  /** null when the device lists no voice at all: the engine is left to its default. */
  voice: TtsVoice | null
  /** The text's language, when no voice speaks it: `voice` is then the stand-in, and speaks something else. */
  missing: string | null
  /** With `missing`: an online voice does speak it, and was not allowed. */
  onlineOnly: boolean
}

/** Language codes that name the same language as the one text detection reports: old ISO 639 codes Android still
 *  uses, the two written forms of Norwegian, and the spoken forms of Chinese. */
const SAME_LANGUAGE: Record<string, string> = {
  iw: 'he',
  in: 'id',
  ji: 'yi',
  nb: 'no',
  nn: 'no',
  cmn: 'zh',
  yue: 'zh',
  fil: 'tl',
}

/** Where a language with several accents is read from when the user's own languages do not say: the text cannot.
 *  For Chinese this also keeps Mandarin ahead of Cantonese (zh-HK), which reads the same characters as other words. */
const HOME_REGIONS: Record<string, string[]> = {
  en: ['US', 'GB'],
  es: ['ES', 'MX', 'US'],
  pt: ['BR', 'PT'],
  fr: ['FR', 'CA'],
  de: ['DE'],
  it: ['IT'],
  nl: ['NL'],
  zh: ['CN', 'TW'],
}

/** The language a voice (or a tag) speaks, as text detection names it: 'pt-BR' → 'pt', 'nb-NO' → 'no', 'cmn-Hans-CN'
 *  → 'zh'. '' for a tag that names none. */
export function voiceLanguage(tag: string): string {
  const primary = primaryLanguage(tag)
  return SAME_LANGUAGE[primary] ?? primary
}

/** A tag's region, upper-cased: 'pt-BR' → 'BR', 'zh_Hans_CN' → 'CN', 'es-419' → '419'; '' when it has none. */
function region(tag: string): string {
  const part = tag.split(/[-_]/).slice(1).find((p) => /^(?:[A-Za-z]{2}|\d{3})$/.test(p))
  return part ? part.toUpperCase() : ''
}

/** The voices that may be used: those on the device, and the online ones too once they are allowed. A device that
 *  marks no voice as local (some Linux speech setups) offers what it has. */
export function usableVoices(voices: readonly TtsVoice[], allowOnline: boolean): TtsVoice[] {
  if (allowOnline || !voices.some((v) => v.local)) return [...voices]
  return voices.filter((v) => v.local)
}

/** The best of `usable` for a language, or null when none speaks it. On the device before online; then the accent of
 *  the user's own languages, then the language's home; then the engine's default. */
function bestFor(usable: readonly TtsVoice[], language: string, preferred: readonly string[]): TtsVoice | null {
  const own = preferred.find((tag) => voiceLanguage(tag) === language && region(tag) !== '')
  const ownRegion = own ? region(own) : ''
  const home = HOME_REGIONS[language] ?? []
  const rank = (v: TtsVoice): number => {
    const r = region(v.lang)
    const at = home.indexOf(r)
    const accent = ownRegion !== '' && r === ownRegion ? 0 : 1 + (at === -1 ? home.length : at)
    return (v.local ? 0 : 1000) + accent * 10 + (v.isDefault ? 0 : 1)
  }
  let best: TtsVoice | null = null
  let bestRank = Infinity
  for (const v of usable) {
    if (voiceLanguage(v.lang) !== language) continue
    const r = rank(v)
    if (r < bestRank) {
      best = v
      bestRank = r
    }
  }
  return best
}

/** The voice for text whose language is not known: one for the first of the user's languages the device speaks. */
function homeVoice(usable: readonly TtsVoice[], preferred: readonly string[]): TtsVoice | null {
  for (const tag of preferred) {
    const language = voiceLanguage(tag)
    const voice = language ? bestFor(usable, language, preferred) : null
    if (voice) return voice
  }
  return usable.find((v) => v.isDefault) ?? usable[0] ?? null
}

/** The voice to read text with. The user's pick is the voice for its own language (and for text whose language could
 *  not be told); text in another language gets a voice of that language. */
export function chooseVoice(voices: readonly TtsVoice[], wish: VoiceWish): VoiceChoice {
  const usable = usableVoices(voices, wish.allowOnline)
  const picked = wish.voiceId ? usable.find((v) => v.id === wish.voiceId) ?? null : null
  const fallback = picked ?? homeVoice(usable, wish.preferred)
  const language = wish.language ? voiceLanguage(wish.language) : ''
  if (!language) return { voice: fallback, missing: null, onlineOnly: false }
  if (picked && voiceLanguage(picked.lang) === language) return { voice: picked, missing: null, onlineOnly: false }
  const match = bestFor(usable, language, wish.preferred)
  if (match) return { voice: match, missing: null, onlineOnly: false }
  // A voice that does not say what it speaks (an engine's one unnamed voice) may well speak this: nothing is known to
  // be missing, and the engine is told the language beside the text.
  if (usable.length === 0 || usable.some((v) => voiceLanguage(v.lang) === '')) return { voice: fallback, missing: null, onlineOnly: false }
  const onlineOnly = !wish.allowOnline && voices.some((v) => !v.local && voiceLanguage(v.lang) === language)
  return { voice: fallback, missing: language, onlineOnly }
}

/** The languages the usable voices speak, as primary subtags, in the order first met. */
export function spokenLanguages(voices: readonly TtsVoice[], allowOnline: boolean): string[] {
  const seen = new Set<string>()
  for (const v of usableVoices(voices, allowOnline)) {
    const language = voiceLanguage(v.lang)
    if (language) seen.add(language)
  }
  return [...seen]
}
