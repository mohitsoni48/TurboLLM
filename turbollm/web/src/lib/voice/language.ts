// Telling what language a reply is written in, so read-aloud can pick a voice that speaks it (voice-choice.ts)
// instead of reading everything with the voice of the browser's language.
//
// It runs in the page, on text that must not leave it, so there is no model and no table of n-grams to download: two
// small stages, both linear in the (capped) text. First by Unicode script, which decides every language that has a
// script to itself and narrows the rest (Cyrillic, Arabic and Han are then told apart by a few letters or words).
// Then, for Latin script, by everyday function words plus the letters only some languages use. When the evidence is
// thin or two languages are close it answers null: a wrong voice on a guess is worse than the caller's fallback.
//
// PURE: no browser API but Intl.DisplayNames, for a language's name.

/** Only this much of the text is examined; a reply's language is evident from its start. */
const MAX_CHARS = 2000
/** Longest token considered a word; longer ones are identifiers, hashes, base64 and the like. */
const MAX_TOKEN = 30

/** A non-Latin script must make up at least this share of all letters to decide the language. */
const SCRIPT_DOMINANCE = 0.6
/** ...and have at least this many letters (Han needs fewer: two characters already say 'hello' in Chinese). */
const SCRIPT_MIN_LETTERS = 4
const HAN_MIN_LETTERS = 2

/** Latin stage: the winner needs at least this much evidence, and this multiple of the runner-up. */
const MIN_SCORE = 2
const MIN_MARGIN = 1.25
const MIN_TOKENS = 2

// ---------------------------------------------------------------------------------------------------------------------
// Stage 1: scripts
// ---------------------------------------------------------------------------------------------------------------------

const LETTER = /\p{L}/u

/** Scripts in the order they are tested; Latin first because it is by far the most common. */
const SCRIPTS: Array<[string, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['han', /\p{Script=Han}/u],
  ['hiragana', /\p{Script=Hiragana}/u],
  ['katakana', /\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['thai', /\p{Script=Thai}/u],
  ['greek', /\p{Script=Greek}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['telugu', /\p{Script=Telugu}/u],
  ['gujarati', /\p{Script=Gujarati}/u],
  ['gurmukhi', /\p{Script=Gurmukhi}/u],
  ['kannada', /\p{Script=Kannada}/u],
  ['malayalam', /\p{Script=Malayalam}/u],
  ['georgian', /\p{Script=Georgian}/u],
  ['armenian', /\p{Script=Armenian}/u],
  ['khmer', /\p{Script=Khmer}/u],
  ['lao', /\p{Script=Lao}/u],
  ['myanmar', /\p{Script=Myanmar}/u],
]

/** Scripts that map to exactly one language. */
const SCRIPT_LANGUAGE: Record<string, string> = {
  hangul: 'ko',
  hebrew: 'he',
  devanagari: 'hi',
  bengali: 'bn',
  thai: 'th',
  greek: 'el',
  tamil: 'ta',
  telugu: 'te',
  gujarati: 'gu',
  gurmukhi: 'pa',
  kannada: 'kn',
  malayalam: 'ml',
  georgian: 'ka',
  armenian: 'hy',
  khmer: 'km',
  lao: 'lo',
  myanmar: 'my',
}

type CharCounts = Map<string, number>

function countChars(text: string): CharCounts {
  const counts: CharCounts = new Map()
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  return counts
}

/** How many times any of `chars` occurs. */
function occurrences(counts: CharCounts, chars: string): number {
  let n = 0
  for (const ch of chars) n += counts.get(ch) ?? 0
  return n
}

/** Everyday Bulgarian words Russian does not have, and the other way round: what tells the two apart in a sentence
 *  too short to show Bulgarian's ъ. Words the two share (и, в, на, не, да, но, как, много) are in neither. */
const BULGARIAN_WORDS = new Set(`ще е са със това тази този тези които който която какво във към като може има няма съм си
  още вече само беше бяха след преди защото когато къде благодаря моля здравей здравейте се те ти той тя ние вие аз ако
  трябва искам мога можете така`.split(/\s+/))
const RUSSIAN_WORDS = new Set(`это что для если уже ещё еще только был была было были есть нет вы мы он она они его её ее
  их чтобы когда где потому спасибо пожалуйста привет можно нужно очень также который которая которые так вот этот эта
  эти или`.split(/\s+/))

const CYRILLIC_WORD = /\p{Script=Cyrillic}+/gu

function cyrillicLanguage(text: string, counts: CharCounts, letters: number): string {
  if (occurrences(counts, 'ў')) return 'be'
  if (occurrences(counts, 'їєґ')) return 'uk'
  const russianOnly = occurrences(counts, 'ыэё')
  if (!russianOnly && occurrences(counts, 'і')) return 'uk'
  if (occurrences(counts, 'ѓќѕ')) return 'mk'
  if (occurrences(counts, 'јљњћђ')) return 'sr'
  if (!russianOnly) {
    // Bulgarian uses ъ as an everyday vowel (about 2-3% of letters); in Russian it is a rare hard sign.
    if (occurrences(counts, 'ъ') >= Math.max(2, letters * 0.012)) return 'bg'
    let bulgarian = 0
    let russian = 0
    for (const word of text.match(CYRILLIC_WORD) ?? []) {
      if (BULGARIAN_WORDS.has(word)) bulgarian++
      else if (RUSSIAN_WORDS.has(word)) russian++
    }
    if (bulgarian > russian) return 'bg'
  }
  return 'ru'
}

function arabicLanguage(counts: CharCounts, letters: number): string {
  if (occurrences(counts, 'ٹڈڑےں')) return 'ur'
  const persian = occurrences(counts, 'پچژگ')
  if (persian >= 1 && persian >= letters * 0.005) return 'fa'
  return 'ar'
}

/** The language of a dominant non-Latin script, or null when no such script dominates (so Latin gets its turn). */
function detectByScript(text: string): string | null {
  const scripts = new Map<string, number>()
  let letters = 0
  for (const ch of text) {
    if (!LETTER.test(ch)) continue
    letters++
    for (const [name, re] of SCRIPTS) {
      if (re.test(ch)) {
        scripts.set(name, (scripts.get(name) ?? 0) + 1)
        break
      }
    }
  }
  if (letters === 0) return null

  const han = scripts.get('han') ?? 0
  const kana = (scripts.get('hiragana') ?? 0) + (scripts.get('katakana') ?? 0)
  const groups = new Map(scripts)
  groups.delete('han')
  groups.delete('hiragana')
  groups.delete('katakana')
  groups.set('cjk', han + kana)

  let best = ''
  let bestCount = 0
  for (const [name, count] of groups) {
    if (name !== 'latin' && count > bestCount) {
      best = name
      bestCount = count
    }
  }
  if (!best || bestCount / letters < SCRIPT_DOMINANCE) return null
  if (bestCount < (best === 'cjk' ? HAN_MIN_LETTERS : SCRIPT_MIN_LETTERS)) return null

  if (best === 'cjk') return kana >= 2 ? 'ja' : 'zh'
  if (best === 'cyrillic') {
    const lower = text.toLowerCase()
    return cyrillicLanguage(lower, countChars(lower), bestCount)
  }
  if (best === 'arabic') return arabicLanguage(countChars(text), bestCount)
  return SCRIPT_LANGUAGE[best] ?? null
}

// ---------------------------------------------------------------------------------------------------------------------
// Stage 2: Latin-script languages
// ---------------------------------------------------------------------------------------------------------------------

/** Very frequent function words per language. Words shared between languages simply count for each of them. */
const WORDS: Record<string, string> = {
  en: `the and of to is that it for with as was on are be this have from or by not but what you your can will would
    there their they we he she his her my an at if do how about which has had been were its our so just me them these
    those because also more some than then into out up when where who why should could very much here only
    don't it's i'm i've i'll that's you're can't isn't doesn't didn't won't`,
  es: `el la los las una un con está están también muy esto eso más pero para por del al es en yo él ella nosotros fue
    tiene hay ya hasta donde cuando porque entonces usted qué cómo de que y no se lo su sus como o si me mi te le les
    nos son ser sobre entre sin todo todos esta este estos otra otro cuál puede pueden hacer tengo tienes gracias bien
    aquí así sí necesito quiero puedo tienes todavía`,
  pt: `não você uma com são está também muito isso mais como para pela pelo dos das à é em um eu ele ela nós foi tem têm
    já até onde quando porque então de que e a o os as se do da no na nos nas por seu sua seus suas ou me mim ser ao
    aos mas isto esse essa esta este aqui bem só ainda sobre entre sem tudo todos pode podem fazer obrigado depois vai
    vou estou estamos tinha era fui te lhe lhes vez tenho preciso`,
  fr: `le la les un une des du de et est en que qui pour dans ce il elle nous vous ils elles je tu on avec sur pas plus
    par au aux ne se son sa ses mais ou où si comme être avoir fait sont ont cette ces mon ma mes ton leur leurs très
    aussi bien tout tous donc alors encore déjà peut peuvent merci c'est à l' d' qu' j' n' s' m' t' c' y suis
    sera était vous`,
  de: `der die das und ist nicht ein eine einen einem einer mit für auf den dem des von zu im in es sie er wir ihr ich
    du auch sich aber wie oder wenn wird werden wurde kann können haben hat hatte sind war waren bei nach aus um als
    noch nur dann dass mehr sehr schon hier diese dieser dieses wo was wer warum danke ja nein dir dich mir mich`,
  it: `il lo la le gli un uno una di che e è in per con non si sono del della dei delle da al alla nel nella su come
    più ma anche se mi ti ci vi io tu lui lei noi voi loro questo questa questi quello quella era ha hanno ho essere
    fare molto tutto tutti già ancora dove quando perché quindi cosa chi cui sia poi solo grazie ciao l' un' dell'
    all' nell' sull' c' d' dimmi posso`,
  nl: `de het een en van is dat niet op te in voor met zijn ik je jij we wij ze zij hij ook maar als aan om bij er dan
    nog naar wat hoe wordt worden werd kan kunnen hebben heeft had was waren zo heel veel meer deze dit die dus omdat
    nu geen wel uit door over tot hun mijn jouw u hier daar waar wie waarom dank ja nee weet kunt welke`,
  pl: `i w z na do nie to że się jest jak ale co tak po od za czy tym ten ta te tego jego jej ich mnie mi ci cię ty ja
    on ona my wy oni już też tylko bardzo być są był była było będzie może można ma mają przez przy dla który która
    które gdzie kiedy dlaczego dziękuję proszę tutaj teraz jeszcze więc bo lub oraz jeśli ją mogę musisz tej tych`,
  tr: `ve bir bu da de için ile ne ama çok gibi daha en ben sen o biz siz onlar var yok mi mı mu mü değil olarak kadar
    sonra önce her bütün bunu şunu bunun şu ki ya hem çünkü evet hayır lütfen teşekkürler nasıl neden nerede olan oldu
    olur olabilir yapmak bana sana ona beni seni eğer gerekiyor tabii`,
  sv: `och att det är som en på för med inte av jag har till ett om den de var han hon vi du man kan ska så men från
    också när eller sig vid blir då mycket bara hur vad här inom efter över under utan mot hade skulle vara ju nu
    något mig dig`,
  da: `og at det er som en på for med ikke af jeg har til et om den de var han hun vi du man kan skal så men fra også
    når eller sig ved bliver da meget bare hvordan hvad her efter over under uden mod havde skulle være jo nu noget
    mig dig nogle hvis hvilken hvorfor`,
  no: `og å det er som en på for med ikke av jeg har til et om den de var han hun vi du man kan skal så men fra også
    når eller seg ved blir da mye bare hvordan hva her etter over under uten mot hadde skulle være jo nå noe meg deg
    veldig noen hvis hvilken hvorfor`,
  fi: `ja on ei että se hän oli ovat mutta kuin tai kun niin myös mitä mikä joka jotka tämä tämän sen ne me te minä
    sinä olen olet olemme ole voi voin voit kanssa hyvin vain jo vielä sitten koska miten missä kuka miksi kiitos
    kyllä jos et ensin sinun minulle sinulle siinä sitä`,
  id: `yang dan di ke dari untuk dengan ini itu pada adalah tidak akan juga atau saya kamu anda kami kita mereka dia
    ada bisa dapat sudah belum sangat lebih sebagai oleh karena jika tetapi namun sebuah satu dalam apa bagaimana
    mengapa kapan dimana terima kasih ya bukan hanya masih lagi saja setelah sebelum semua kalau nanti punya`,
  vi: `và của là có không một những các được trong cho này đã người với để khi tôi bạn anh chị rất cũng nhưng như thì
    sẽ đang ở lại ra vào nó họ chúng ta mình sao gì đâu nào thế vậy hay hoặc nếu vì nên còn đến từ về cảm ơn xin`,
  ro: `și şi în de la cu pe este sunt un o nu că care pentru din mai sau dar ce cum se să le lui lor am ai are avem aveți
    au fost fi va vor foarte acest această aceasta acești acestea tot toate dacă când unde cine mulțumesc mulţumesc te
    mă mi ne vă îți își iar însă trebuie pot`,
  cs: `a je to se na že s v z do o i ale jako jsem jsi jsme jste jsou byl byla bylo bude být by si ne co jak když nebo
    pro při po od za který která které tento tato toto tady tam kde proč protože už jen také velmi ještě můj tvůj náš
    váš ten ta ty on ona my vy oni mít má mají může můžete děkuji prosím ano vám pokud já mohu musíte jakou ji
    jestli až budeš budu budeme`,
  hu: `a az és hogy nem is egy van volt meg de ez ezt azt ami mint vagy csak már még nagyon én te ő mi ti ők ön fel el
    ki be le át rá itt ott hol mikor miért hogyan kell lehet nincs vannak lesz minden akkor ha mert után előtt között
    szerint köszönöm igen neked ebben`,
  ca: `el la els les un una i de que a en per amb no és són es se té tenen hi ha ho això aquest aquesta aquests però o
    com més molt també ja quan on perquè doncs jo tu ell ella nosaltres vosaltres ells elles meu teu seu del al dels
    als pel mateix tot tots gràcies sí l' d' s' m' t' n' et puc has quina fas`,
}

/** Word -> languages that list it. */
const WORD_INDEX: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>()
  for (const [lang, list] of Object.entries(WORDS)) {
    for (const word of new Set(list.split(/\s+/).filter(Boolean))) {
      const langs = index.get(word)
      if (langs) langs.push(lang)
      else index.set(word, [lang])
    }
  }
  return index
})()

/** Distinctive letters: characters, the languages they point to, the weight per occurrence, and a cap on occurrences. */
const LETTER_RULES: Array<{ chars: string; langs: string[]; weight: number; cap: number }> = [
  { chars: 'ãõ', langs: ['pt'], weight: 1, cap: 3 },
  { chars: 'ñ¿¡', langs: ['es'], weight: 1, cap: 3 },
  { chars: 'ß', langs: ['de'], weight: 1, cap: 3 },
  { chars: 'łąęśźżćń', langs: ['pl'], weight: 1, cap: 3 },
  { chars: 'ığ̇', langs: ['tr'], weight: 1, cap: 3 },
  { chars: 'ş', langs: ['tr'], weight: 1, cap: 3 },
  { chars: 'ş', langs: ['ro'], weight: 0.5, cap: 3 },
  { chars: 'ţ', langs: ['ro'], weight: 1, cap: 3 },
  { chars: 'řěů', langs: ['cs'], weight: 1, cap: 3 },
  { chars: 'čšž', langs: ['cs'], weight: 0.5, cap: 3 },
  { chars: 'őű', langs: ['hu'], weight: 1, cap: 3 },
  { chars: 'ășț', langs: ['ro'], weight: 1, cap: 3 },
  { chars: 'å', langs: ['sv', 'da', 'no'], weight: 1, cap: 3 },
  { chars: 'øæ', langs: ['da', 'no'], weight: 1, cap: 3 },
  { chars: 'äö', langs: ['de', 'sv', 'fi'], weight: 0.5, cap: 3 },
  { chars: 'ü', langs: ['de', 'tr'], weight: 0.5, cap: 3 },
  { chars: 'ç', langs: ['pt', 'fr', 'ca', 'tr'], weight: 0.5, cap: 3 },
  { chars: 'àèìòù', langs: ['it', 'ca', 'fr'], weight: 0.3, cap: 3 },
  { chars: 'œ', langs: ['fr'], weight: 1, cap: 3 },
  { chars: '·', langs: ['ca'], weight: 1, cap: 3 },
  {
    chars: 'ơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ',
    langs: ['vi'],
    weight: 1,
    cap: 6,
  },
]

function wordWeight(word: string): number {
  const length = [...word].length
  if (length >= 3) return 1
  return length === 2 ? 0.5 : 0.25
}

const URL_OR_EMAIL = /\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/giu
const TOKEN = /[\p{L}\p{M}\p{N}'’]+/gu
const HAS_DIGIT = /\p{N}/u

/** Words worth scoring: lower-cased, with URLs, e-mails, digit-bearing tokens, all-caps acronyms and giants dropped. */
function wordsOf(text: string): string[] {
  const out: string[] = []
  const tokens = text.replace(URL_OR_EMAIL, ' ').match(TOKEN) ?? []
  for (const raw of tokens) {
    if (raw.length > MAX_TOKEN || HAS_DIGIT.test(raw)) continue
    if (raw.length >= 2 && raw === raw.toUpperCase() && raw !== raw.toLowerCase()) continue
    const token = raw.replace(/’/g, "'").toLowerCase().replace(/^'+/, '')
    if (token) out.push(token)
  }
  return out
}

function addWord(scores: Map<string, number>, word: string): boolean {
  const langs = WORD_INDEX.get(word)
  if (!langs) return false
  const weight = wordWeight(word)
  for (const lang of langs) scores.set(lang, (scores.get(lang) ?? 0) + weight)
  return true
}

function scoreLatin(text: string): { scores: Map<string, number>; tokens: number } {
  const words = wordsOf(text)
  const scores = new Map<string, number>()
  for (const word of words) {
    if (addWord(scores, word)) continue
    // Elisions and contractions: l'homme -> l' + homme, don't is listed whole, qu'il -> qu' + il.
    const cut = word.indexOf("'")
    if (cut > 0 && cut < word.length - 1) {
      addWord(scores, word.slice(0, cut + 1))
      addWord(scores, word.slice(cut + 1))
    }
  }

  const counts = countChars(words.join(' '))
  for (const rule of LETTER_RULES) {
    const n = Math.min(occurrences(counts, rule.chars), rule.cap)
    if (n === 0) continue
    for (const lang of rule.langs) scores.set(lang, (scores.get(lang) ?? 0) + n * rule.weight)
  }
  return { scores, tokens: words.length }
}

function detectLatin(text: string): string | null {
  const { scores, tokens } = scoreLatin(text)
  if (tokens < MIN_TOKENS) return null

  let top = ''
  let topScore = 0
  for (const [lang, score] of scores) {
    if (score > topScore) {
      top = lang
      topScore = score
    }
  }
  if (!top || topScore < MIN_SCORE) return null

  // Danish and Norwegian share most of their vocabulary: they compete with each other freely, and only the rest must
  // be clearly beaten.
  const siblings = top === 'da' || top === 'no' ? ['da', 'no'] : [top]
  let runnerUp = 0
  for (const [lang, score] of scores) {
    if (!siblings.includes(lang) && score > runnerUp) runnerUp = score
  }
  if (topScore < MIN_MARGIN * runnerUp) return null

  if (siblings.length === 2) {
    const da = scores.get('da') ?? 0
    const no = scores.get('no') ?? 0
    return no > da ? 'no' : 'da'
  }
  return top
}

// ---------------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------------

/** The language `text` is written in, as a lower-case primary language subtag ('en', 'pt', 'zh', 'ja'…), or null when
 *  it cannot tell (too short, mixed, a language it does not know). */
export function detectLanguage(text: string): string | null {
  if (!text) return null
  const sample = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text
  const normalized = sample.normalize('NFC')
  return detectByScript(normalized) ?? detectLatin(normalized)
}

const CYRILLIC_LANGUAGES = ['ru', 'uk', 'be', 'bg', 'sr', 'mk']
const ARABIC_LANGUAGES = ['ar', 'fa', 'ur']
const HAN_LANGUAGES = ['zh', 'ja']

/** The writing system a language {@link detectLanguage} returns was told by. Two languages of one script are told
 *  apart by a few letters or words, which a single sentence may not have; two of different scripts cannot be mixed up.
 *  A language with a script of its own (and one this module does not know) is its own script. */
export function languageScript(language: string): string {
  if (Object.hasOwn(WORDS, language)) return 'latin'
  if (CYRILLIC_LANGUAGES.includes(language)) return 'cyrillic'
  if (ARABIC_LANGUAGES.includes(language)) return 'arabic'
  if (HAN_LANGUAGES.includes(language)) return 'han'
  return language
}

/** A language tag's primary subtag, lower-cased: 'pt-BR' → 'pt', 'zh_CN' → 'zh', 'EN' → 'en', '' → ''. */
export function primaryLanguage(tag: string): string {
  return (tag.trim().split(/[-_]/)[0] ?? '').toLowerCase()
}

let displayNames: Intl.DisplayNames | null | undefined

/** The English name of a language for a tag ('pt-BR' → 'Portuguese (Brazil)', 'ja' → 'Japanese'), via Intl.DisplayNames
 *  when the runtime has it, else the tag itself. Never throws. */
export function languageName(tag: string): string {
  try {
    if (displayNames === undefined) {
      displayNames =
        typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
          ? new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' })
          : null
    }
    return displayNames?.of(tag.replace(/_/g, '-')) || tag
  } catch {
    return tag
  }
}
