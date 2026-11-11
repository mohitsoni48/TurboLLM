// "This is how replies will sound", in the languages a voice is likely to speak: Settings → Voice plays the one in
// the chosen voice's language, since a voice asked to read another language says little about how it sounds.
import { voiceLanguage } from './voice-choice'

const SAMPLES: Record<string, string> = {
  en: 'This is how replies will sound.',
  es: 'Así sonarán las respuestas.',
  pt: 'É assim que as respostas vão soar.',
  fr: 'Voici comment les réponses seront lues.',
  de: 'So klingen die Antworten.',
  it: 'Ecco come suoneranno le risposte.',
  nl: 'Zo klinken de antwoorden.',
  pl: 'Tak będą brzmiały odpowiedzi.',
  tr: 'Yanıtlar böyle seslendirilecek.',
  sv: 'Så här kommer svaren att låta.',
  da: 'Sådan kommer svarene til at lyde.',
  no: 'Slik vil svarene høres ut.',
  fi: 'Tältä vastaukset kuulostavat.',
  id: 'Seperti inilah jawaban akan terdengar.',
  vi: 'Câu trả lời sẽ được đọc như thế này.',
  ro: 'Așa vor suna răspunsurile.',
  cs: 'Takto budou odpovědi znít.',
  hu: 'Így fognak hangzani a válaszok.',
  ca: 'Així sonaran les respostes.',
  ru: 'Так будут звучать ответы.',
  uk: 'Так звучатимуть відповіді.',
  bg: 'Така ще звучат отговорите.',
  el: 'Έτσι θα ακούγονται οι απαντήσεις.',
  ar: 'هكذا ستُقرأ الردود.',
  he: 'כך יישמעו התשובות.',
  hi: 'उत्तर इस तरह सुनाई देंगे।',
  th: 'คำตอบจะมีเสียงแบบนี้',
  zh: '回复听起来会是这样的。',
  ja: '返信はこのように読み上げられます。',
  ko: '답변은 이렇게 들립니다.',
}

/** The sample for a language tag and the language it is in: the tag's own when there is one, else English. */
export function sampleFor(tag: string): { text: string; language: string } {
  const language = voiceLanguage(tag)
  return Object.hasOwn(SAMPLES, language) ? { text: SAMPLES[language], language } : { text: SAMPLES.en, language: 'en' }
}
