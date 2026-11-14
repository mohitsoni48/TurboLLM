import { describe, expect, it } from 'vitest'
import { detectLanguage } from './language'
import { sampleFor } from './samples'

describe('sampleFor', () => {
  it('gives the sample of the tag\'s language, with that language', () => {
    expect(sampleFor('pt-BR')).toEqual({ text: 'É assim que as respostas vão soar.', language: 'pt' })
    expect(sampleFor('es_MX')).toMatchObject({ language: 'es', text: 'Así sonarán las respuestas.' })
    expect(sampleFor('EN-gb')).toMatchObject({ language: 'en' })
  })

  it('follows the aliases a voice may use for a language', () => {
    expect(sampleFor('nb-NO')).toMatchObject({ language: 'no', text: 'Slik vil svarene høres ut.' })
    expect(sampleFor('nn-NO').language).toBe('no')
    expect(sampleFor('cmn-Hans-CN').language).toBe('zh')
    expect(sampleFor('iw-IL').language).toBe('he')
    expect(sampleFor('in-ID').language).toBe('id')
  })

  it('gives the English sample for a language without one, and for no language', () => {
    const english = { text: 'This is how replies will sound.', language: 'en' }
    expect(sampleFor('xx-XX')).toEqual(english)
    expect(sampleFor('')).toEqual(english)
    expect(sampleFor('constructor')).toEqual(english)
  })
})

describe('the samples', () => {
  // A sample is read with its language given, so detection is not what picks the voice; but it should never contradict
  // the language it is labelled with. Detection may decline (null): one short sentence is little to go on.
  const LANGUAGES = [
    'en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'tr', 'sv', 'da', 'no', 'fi', 'id', 'vi', 'ro', 'cs', 'hu', 'ca',
    'ru', 'uk', 'bg', 'el', 'ar', 'he', 'hi', 'th', 'zh', 'ja', 'ko',
  ]

  it('tells the Bulgarian sample from Russian', () => {
    expect(detectLanguage(sampleFor('bg').text)).toBe('bg')
  })

  it.each(LANGUAGES)('is not taken for another language by detectLanguage: %s', (language) => {
    const sample = sampleFor(language)
    expect(sample.language).toBe(language)
    const detected = detectLanguage(sample.text)
    expect([language, null]).toContain(detected)
  })
})
