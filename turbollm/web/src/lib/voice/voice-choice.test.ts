import { describe, expect, it } from 'vitest'
import { chooseVoice, spokenLanguages, usableVoices, voiceLanguage, type TtsVoice, type VoiceWish } from './voice-choice'

const v = (id: string, lang: string, over: Partial<TtsVoice> = {}): TtsVoice => ({ id, name: id, lang, local: true, ...over })
const online = (id: string, lang: string, over: Partial<TtsVoice> = {}): TtsVoice => v(id, lang, { local: false, ...over })

const wish = (over: Partial<VoiceWish> = {}): VoiceWish => ({ voiceId: '', language: null, allowOnline: false, preferred: ['en-US'], ...over })
const idOf = (voices: TtsVoice[], over: Partial<VoiceWish> = {}) => chooseVoice(voices, wish(over)).voice?.id ?? null

describe('voiceLanguage', () => {
  it.each([
    ['pt-BR', 'pt'],
    ['nb-NO', 'no'],
    ['nn', 'no'],
    ['no', 'no'],
    ['iw-IL', 'he'],
    ['in-ID', 'id'],
    ['cmn-Hans-CN', 'zh'],
    ['yue-HK', 'zh'],
    ['fil-PH', 'tl'],
    ['en_US', 'en'],
    ['EN', 'en'],
    ['', ''],
  ])('%s is %s', (tag, language) => {
    expect(voiceLanguage(tag)).toBe(language)
  })
})

describe('usableVoices', () => {
  const voices = [v('a', 'en-US'), online('b', 'ja-JP'), v('c', 'es-ES')]

  it('is the voices on the device by default', () => {
    expect(usableVoices(voices, false).map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('is every voice when online ones are allowed', () => {
    expect(usableVoices(voices, true).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('is every voice when the device marks none as local', () => {
    const none = [online('a', 'en-US'), online('b', 'ja-JP')]
    expect(usableVoices(none, false).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('does not change what it is given', () => {
    const input = [online('b', 'ja-JP'), v('a', 'en-US')]
    const copy = structuredClone(input)
    const all = usableVoices(input, true)
    const local = usableVoices(input, false)
    expect(input).toEqual(copy)
    expect(all).not.toBe(input)
    expect(local).not.toBe(input)
    all.reverse()
    expect(input).toEqual(copy)
  })
})

describe('chooseVoice, automatic', () => {
  it('reads Spanish with a Spanish voice, never the English one', () => {
    const voices = [v('en', 'en-US', { isDefault: true }), v('es-ES', 'es-ES'), v('es-MX', 'es-MX')]
    const choice = chooseVoice(voices, wish({ language: 'es' }))
    expect(choice.voice?.lang.startsWith('es')).toBe(true)
    expect(choice.missing).toBeNull()
    expect(choice.onlineOnly).toBe(false)
    expect(idOf([v('en', 'en-US', { isDefault: true }), v('es-MX', 'es-MX')], { language: 'es' })).toBe('es-MX')
  })

  it('takes the accent of the user\'s own language when they have one for it', () => {
    const voices = [v('en', 'en-US'), v('es-ES', 'es-ES'), v('es-MX', 'es-MX')]
    expect(idOf(voices, { language: 'es', preferred: ['es-MX', 'en-US'] })).toBe('es-MX')
  })

  it('takes the language\'s home region when the user\'s languages do not say', () => {
    const voices = [v('en', 'en-US'), v('es-MX', 'es-MX'), v('es-ES', 'es-ES')]
    expect(idOf(voices, { language: 'es', preferred: ['en-US'] })).toBe('es-ES')
  })

  it('ignores a preferred tag with no region (it names no accent)', () => {
    const voices = [v('es-MX', 'es-MX'), v('es-ES', 'es-ES')]
    expect(idOf(voices, { language: 'es', preferred: ['es'] })).toBe('es-ES')
  })

  it('prefers Brazilian to European Portuguese, and American to British English', () => {
    expect(idOf([v('pt-PT', 'pt-PT'), v('pt-BR', 'pt-BR')], { language: 'pt' })).toBe('pt-BR')
    expect(idOf([v('en-GB', 'en-GB'), v('en-US', 'en-US')], { language: 'en', preferred: ['de-DE'] })).toBe('en-US')
  })

  it('prefers Mandarin of the mainland to Taiwan to Hong Kong, and uses a Cantonese voice when it is the only Chinese one', () => {
    const voices = [v('zh-HK', 'zh-HK'), v('zh-TW', 'zh-TW'), v('zh-CN', 'zh-CN')]
    expect(idOf(voices, { language: 'zh' })).toBe('zh-CN')
    expect(idOf(voices.filter((x) => x.id !== 'zh-CN'), { language: 'zh' })).toBe('zh-TW')
    expect(idOf([v('en', 'en-US'), v('yue', 'yue-HK')], { language: 'zh' })).toBe('yue')
  })

  it('prefers a voice on the device to an online one of a better region, even when online is allowed', () => {
    const voices = [online('es-ES-net', 'es-ES'), v('es-MX-local', 'es-MX')]
    expect(idOf(voices, { language: 'es', allowOnline: true })).toBe('es-MX-local')
    expect(idOf(voices, { language: 'es', allowOnline: false })).toBe('es-MX-local')
  })

  it('uses an online voice, when allowed, for a language no voice on the device speaks', () => {
    const voices = [v('en', 'en-US'), online('ja', 'ja-JP')]
    expect(chooseVoice(voices, wish({ language: 'ja', allowOnline: true }))).toEqual({ voice: voices[1], missing: null, onlineOnly: false })
  })

  it('breaks a tie by the engine\'s default voice, and otherwise keeps the first', () => {
    expect(idOf([v('a', 'es-ES'), v('b', 'es-ES', { isDefault: true })], { language: 'es' })).toBe('b')
    expect(idOf([v('a', 'es-ES'), v('b', 'es-ES')], { language: 'es' })).toBe('a')
  })

  describe('for text whose language is not known', () => {
    it('uses a voice for the first of the user\'s languages the device speaks', () => {
      const voices = [v('en', 'en-US', { isDefault: true }), v('de', 'de-DE'), v('fr', 'fr-FR')]
      expect(idOf(voices, { language: null, preferred: ['it-IT', 'fr-FR', 'de-DE'] })).toBe('fr')
    })

    it('uses the engine\'s default voice when it speaks none of them', () => {
      const voices = [v('de', 'de-DE'), v('fr', 'fr-FR', { isDefault: true })]
      expect(idOf(voices, { language: null, preferred: ['en-US'] })).toBe('fr')
    })

    it('uses the first voice when none is the default', () => {
      expect(idOf([v('de', 'de-DE'), v('fr', 'fr-FR')], { language: null, preferred: ['en-US'] })).toBe('de')
    })

    it('reports nothing missing', () => {
      expect(chooseVoice([v('de', 'de-DE')], wish({ language: null })).missing).toBeNull()
    })
  })

  describe('with no voices at all', () => {
    it('has no voice for text of no known language', () => {
      expect(chooseVoice([], wish())).toEqual({ voice: null, missing: null, onlineOnly: false })
    })

    it('has no voice for a named language either, and does not call it missing (the engine is left to its default)', () => {
      expect(chooseVoice([], wish({ language: 'ja' }))).toEqual({ voice: null, missing: null, onlineOnly: false })
    })
  })
})

describe('chooseVoice, a voice the user picked', () => {
  const voices = [v('en', 'en-US', { isDefault: true }), v('de', 'de-DE'), v('de-AT', 'de-AT'), v('es', 'es-ES')]

  it('is used for text in its own language', () => {
    expect(idOf(voices, { voiceId: 'de-AT', language: 'de' })).toBe('de-AT')
  })

  it('is used when the language of the text is not known', () => {
    expect(idOf(voices, { voiceId: 'de-AT', language: null })).toBe('de-AT')
  })

  it('gives way to a voice of the text\'s language for text in another one', () => {
    const choice = chooseVoice(voices, wish({ voiceId: 'de-AT', language: 'es' }))
    expect(choice.voice?.id).toBe('es')
    expect(choice.missing).toBeNull()
  })

  it('stands in, with the language reported missing, when no voice speaks the text\'s language', () => {
    const choice = chooseVoice(voices, wish({ voiceId: 'de-AT', language: 'ja' }))
    expect(choice).toEqual({ voice: voices[2], missing: 'ja', onlineOnly: false })
  })

  it('counts a voice by the language of its tag, however written', () => {
    expect(idOf([v('nb', 'nb-NO'), v('en', 'en-US')], { voiceId: 'nb', language: 'no' })).toBe('nb')
  })

  it('behaves as automatic when it is an online voice and online voices are not allowed', () => {
    const list = [v('en', 'en-US'), online('es-net', 'es-ES'), v('es-local', 'es-MX')]
    expect(idOf(list, { voiceId: 'es-net', language: null, allowOnline: false })).toBe('en')
    expect(idOf(list, { voiceId: 'es-net', language: 'es', allowOnline: false })).toBe('es-local')
    expect(idOf(list, { voiceId: 'es-net', language: 'es', allowOnline: true })).toBe('es-net')
  })

  it('behaves as automatic when it no longer exists', () => {
    const list = [v('en', 'en-US'), v('es', 'es-ES')]
    expect(idOf(list, { voiceId: 'gone', language: 'es' })).toBe('es')
    expect(idOf(list, { voiceId: 'gone', language: null, preferred: ['es-ES'] })).toBe('es')
  })
})

describe('chooseVoice, a language with no voice', () => {
  const local = [v('en', 'en-US', { isDefault: true }), v('es', 'es-ES')]

  it('reads with the voice the user would otherwise hear, and says which language was missing', () => {
    expect(chooseVoice(local, wish({ language: 'ja' }))).toEqual({ voice: local[0], missing: 'ja', onlineOnly: false })
  })

  it('says an online voice would speak it, when one exists and is not allowed', () => {
    const voices = [...local, online('ja', 'ja-JP')]
    expect(chooseVoice(voices, wish({ language: 'ja', allowOnline: false }))).toEqual({ voice: local[0], missing: 'ja', onlineOnly: true })
  })

  it('uses that online voice once it is allowed', () => {
    const voices = [...local, online('ja', 'ja-JP')]
    expect(chooseVoice(voices, wish({ language: 'ja', allowOnline: true }))).toEqual({ voice: voices[2], missing: null, onlineOnly: false })
  })

  it('does not say an online voice exists for another language', () => {
    const voices = [...local, online('fr', 'fr-FR')]
    expect(chooseVoice(voices, wish({ language: 'ja' })).onlineOnly).toBe(false)
  })

  it('never reports a language missing on a device whose only voice does not say what it speaks', () => {
    const voices = [v('unnamed', '')]
    expect(chooseVoice(voices, wish({ language: 'ja' }))).toEqual({ voice: voices[0], missing: null, onlineOnly: false })
  })

  it('never reports a language missing when any voice does not say what it speaks', () => {
    const voices = [v('en', 'en-US'), v('unnamed', '')]
    expect(chooseVoice(voices, wish({ language: 'ja' })).missing).toBeNull()
  })
})

describe('spokenLanguages', () => {
  it('lists each language once, in the order first met', () => {
    const voices = [v('a', 'en-US'), v('b', 'es-ES'), v('c', 'en-GB'), v('d', 'es-MX'), v('e', 'de-DE')]
    expect(spokenLanguages(voices, false)).toEqual(['en', 'es', 'de'])
  })

  it('folds the aliases of one language into one', () => {
    expect(spokenLanguages([v('a', 'nb-NO'), v('b', 'nn-NO'), v('c', 'iw-IL'), v('d', 'he-IL')], false)).toEqual(['no', 'he'])
  })

  it('counts online voices only when they are allowed', () => {
    const voices = [v('a', 'en-US'), online('b', 'ja-JP')]
    expect(spokenLanguages(voices, false)).toEqual(['en'])
    expect(spokenLanguages(voices, true)).toEqual(['en', 'ja'])
  })

  it('skips voices that do not say their language', () => {
    expect(spokenLanguages([v('a', ''), v('b', 'fr-FR')], false)).toEqual(['fr'])
    expect(spokenLanguages([], false)).toEqual([])
  })
})
