// The heard cut (arch 2.7, A4, ADR-464 "keep only the text heard"): a spoken reply interrupted after the listener heard
// `heardMs` of a `clipMs` clip keeps the text up to the last whole sentence at that point, and the samples heard.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HEARD_COMPLETE_FRACTION, heardPcm, heardText, proportionalEstimator, type HeardEstimator } from './spoken-reply-cut'

const TWO = 'One two three. Four five six.' // 29 characters; the first sentence ends at 14

test('the reply counts as heard in full at 97 % of its clip', () => {
  assert.equal(HEARD_COMPLETE_FRACTION, 0.97)
})

test('heardText: table of the rules', () => {
  const cases: Array<[string, string, number, number, string]> = [
    ['nothing heard keeps nothing', TWO, 0, 1000, ''],
    ['half heard keeps the first whole sentence', TWO, 600, 1000, 'One two three.'],
    ['the estimate landing on a terminator keeps that sentence', TWO, 483, 1000, 'One two three.'],
    ['short of the first terminator keeps nothing', TWO, 400, 1000, ''],
    ['just under 97 % still snaps back', TWO, 969, 1000, 'One two three.'],
    ['exactly 97 % is the whole reply', TWO, 970, 1000, TWO],
    ['more than the clip is the whole reply', TWO, 5000, 1000, TWO],
    ['! ends a sentence', 'Yes! And then more.', 500, 1000, 'Yes!'],
    ['? ends a sentence', 'Why? Because it is.', 500, 1000, 'Why?'],
    ['… ends a sentence', 'Well… that is all there is.', 500, 1000, 'Well…'],
    ['a newline ends a sentence, and the cut is trimmed', 'A list\nthen more words follow', 500, 1000, 'A list'],
    ['。 ends a sentence', '你好。今天天气很好呢', 500, 1000, '你好。'],
    ['！ ends a sentence', '太好了！我们走吧走吧', 500, 1000, '太好了！'],
    ['？ ends a sentence', '是吗？我不知道啊啊', 500, 1000, '是吗？'],
    ['no terminator at all keeps nothing', 'just words and more words', 500, 1000, ''],
    ['leading space before the kept sentence is trimmed', '  Hi. There is more.', 500, 1000, 'Hi.'],
  ]
  for (const [why, text, heardMs, clipMs, expected] of cases) assert.equal(heardText(text, heardMs, clipMs), expected, why)
})

test('heardText: an injected estimator decides how many characters were heard before the snap', () => {
  const seen: Array<[string, number, number]> = []
  const allButLast: HeardEstimator = (text, heardMs, clipMs) => { seen.push([text, heardMs, clipMs]); return text.length - 1 }
  assert.equal(heardText(TWO, 10, 1000, allButLast), 'One two three.')
  assert.deepEqual(seen, [[TWO, 10, 1000]])
  assert.equal(heardText(TWO, 10, 1000, () => 9999), TWO, 'an estimate past the end keeps everything')
})

test('proportionalEstimator: the heard fraction of the characters, rounded down', () => {
  assert.equal(proportionalEstimator(TWO, 500, 1000), 14)
  assert.equal(proportionalEstimator(TWO, 0, 1000), 0)
})

test('heardPcm: the samples heard, whole samples only, never longer than the clip, and possibly none', () => {
  const pcm = Buffer.alloc(48_000) // one second of 24 kHz PCM16
  assert.equal(heardPcm(pcm, 24_000, 500).length, 24_000)
  assert.equal(heardPcm(pcm, 24_000, 0.01).length, 0, 'less than one sample is none (PG-5)')
  assert.equal(heardPcm(pcm, 24_000, 0).length, 0)
  assert.equal(heardPcm(pcm, 24_000, 5000).length, 48_000, 'more than the clip is the clip')
  assert.equal(heardPcm(Buffer.alloc(7), 1000, 10_000).length, 6, 'an odd trailing byte is not a sample')
  assert.equal(heardPcm(pcm, 16_000, 1).length % 2, 0)
  assert.equal(heardPcm(pcm, 22_050, 333).length, Math.floor((22_050 * 333) / 1000) * 2)
})
