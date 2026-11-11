import { describe, expect, it } from 'vitest'
import { completeLength, speakableText, speechPieces } from './speakable'

describe('speakableText', () => {
  it('is empty for empty or whitespace input', () => {
    expect(speakableText('')).toBe('')
    expect(speakableText('  \n\t \n')).toBe('')
  })

  it('drops a closed fenced code block and keeps the prose around it', () => {
    expect(speakableText('Try this:\n```js\nconst x = 1\n```\nThen run it.')).toBe('Try this:\nThen run it.')
  })

  it('drops a fenced block that is still open at the end', () => {
    expect(speakableText('Try this:\n```python\nfor i in range(3):\n    print(i)')).toBe('Try this:')
  })

  it('drops a ~~~ fence too', () => {
    expect(speakableText('A\n~~~\ncode\n~~~\nB')).toBe('A\nB')
  })

  it('keeps the text of inline code and drops its backticks', () => {
    expect(speakableText('Call `foo()` now')).toBe('Call foo() now')
  })

  it('removes bold, italic and strikethrough markers', () => {
    expect(speakableText('This is **bold**, *italic*, _also italic_ and ~~gone~~.')).toBe('This is bold, italic, also italic and gone.')
  })

  it('removes heading, list and blockquote markers', () => {
    expect(speakableText('# Title\n## Sub\n- one\n* two\n1. three\n2) four\n> quoted')).toBe('Title\nSub\none\ntwo\nthree\nfour\nquoted')
  })

  it('removes task-list checkboxes', () => {
    expect(speakableText('- [x] done\n- [ ] todo')).toBe('done\ntodo')
  })

  it('reads a table as its cells joined by commas, without the divider row', () => {
    expect(speakableText('| Name | Age |\n| --- | :---: |\n| Ann | 30 |')).toBe('Name, Age\nAnn, 30')
  })

  it('drops horizontal rules', () => {
    expect(speakableText('Above\n\n---\n\nBelow\n***\nEnd')).toBe('Above\nBelow\nEnd')
  })

  it('removes HTML tags and keeps what is inside them', () => {
    expect(speakableText('Press <kbd>Ctrl</kbd> and <br/> go')).toBe('Press Ctrl and go')
  })

  it('drops <think> reasoning, closed or still open', () => {
    expect(speakableText('<think>hmm, let me see</think>The answer is 4.')).toBe('The answer is 4.')
    expect(speakableText('Hello. <think>still thinking about')).toBe('Hello.')
  })

  it('removes citation marks', () => {
    expect(speakableText('It is round.[1] Also true.[^2] Really【3†source】.')).toBe('It is round. Also true. Really.')
  })

  it('removes emoji', () => {
    expect(speakableText('Great job 🎉 done ✅')).toBe('Great job done')
  })

  it('keeps the text of a link and drops its address', () => {
    expect(speakableText('See [the docs](https://example.com/docs) for more.')).toBe('See the docs for more.')
  })

  it('says a bare URL as its host, without www.', () => {
    expect(speakableText('Visit https://www.example.com/a/b?x=1 today')).toBe('Visit example.com today')
    expect(speakableText('Visit <https://docs.example.org/x> today')).toBe('Visit docs.example.org today')
  })

  it('keeps the alt text of an image', () => {
    expect(speakableText('Look ![a red cat](https://x.test/cat.png) here')).toBe('Look a red cat here')
  })

  it('leaves snake_case identifiers and multiplication alone', () => {
    expect(speakableText('Use my_var_name and other_thing here')).toBe('Use my_var_name and other_thing here')
    expect(speakableText('2 * 3 * 4 = 24')).toBe('2 * 3 * 4 = 24')
  })

  it('keeps paragraphs and list items on separate lines', () => {
    expect(speakableText('First paragraph.\n\nSecond paragraph.\n\n- a\n- b')).toBe('First paragraph.\nSecond paragraph.\na\nb')
  })
})

describe('completeLength', () => {
  it('is 0 while the first sentence is still in progress', () => {
    expect(completeLength('')).toBe(0)
    expect(completeLength('Hello there, how are')).toBe(0)
  })

  it('counts complete sentences up to and including the terminator and the space after it', () => {
    const text = 'One. Two! Three? Fou'
    expect(completeLength(text)).toBe('One. Two! Three? '.length)
  })

  it('counts a newline as a boundary', () => {
    expect(completeLength('A heading\nand then')).toBe('A heading\n'.length)
  })

  // "3.14" and "e.g." end in the middle of a number or an abbreviation until the next character shows they do not.
  it('does not count a terminator at the very end of the text, but does once more text follows', () => {
    expect(completeLength('It is 3.')).toBe(0)
    expect(completeLength('It is 3. Then')).toBe('It is 3. '.length)
    expect(completeLength('It is 3.14 and')).toBe(0)
  })

  it('needs no space after a CJK full stop', () => {
    expect(completeLength('你好。再见')).toBe('你好。'.length)
  })

  it('takes a closing quote or bracket along with the terminator', () => {
    expect(completeLength('He said "stop." Then')).toBe('He said "stop." '.length)
  })
})

describe('speechPieces', () => {
  const words = (pieces: string[]): string[] => pieces.join(' ').split(/\s+/).filter(Boolean)

  it('is empty for no text', () => {
    expect(speechPieces('')).toEqual([])
  })

  it('merges short sentences into one piece', () => {
    expect(speechPieces('One. Two. Three.')).toEqual(['One. Two. Three.'])
  })

  it('keeps long sentences apart, never past about 220 characters a piece', () => {
    const a = `${'alpha '.repeat(30).trim()}.`
    const b = `${'beta '.repeat(30).trim()}.`
    expect(a.length).toBeGreaterThan(150)
    expect(speechPieces(`${a} ${b}`)).toEqual([a, b])
  })

  it('never joins across a line break', () => {
    expect(speechPieces('Short.\nAlso short.')).toEqual(['Short.', 'Also short.'])
  })

  it('cuts a 600-character sentence without punctuation into pieces of at most 220 characters, at spaces', () => {
    const text = Array.from({ length: 130 }, (_, i) => `w${String(i).padStart(3, '0')}`).join(' ')
    expect(text.length).toBeGreaterThanOrEqual(600)
    const pieces = speechPieces(text)
    expect(pieces.length).toBeGreaterThanOrEqual(3)
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(220)
      expect(piece).toMatch(/^w\d{3}( w\d{3})*$/)
    }
    expect(words(pieces)).toEqual(text.split(' '))
  })

  it('cuts a long run with no space at the limit rather than looping', () => {
    const pieces = speechPieces('x'.repeat(500))
    expect(pieces.every((p) => p.length > 0 && p.length <= 220)).toBe(true)
    expect(pieces.join('')).toBe('x'.repeat(500))
  })

  it('never makes an empty piece, and loses no words', () => {
    const text = 'First.   Second!\n\n   \nThird? Fourth… And a fifth one, with a comma. 你好。再见！'
    const pieces = speechPieces(text)
    expect(pieces.every((p) => p.trim() !== '')).toBe(true)
    // The CJK sentences need no space between them, so they come out as pieces of their own: compare without spaces.
    expect(pieces.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })
})
