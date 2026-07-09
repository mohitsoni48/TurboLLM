// Regression coverage for isDuplicateFact's Jaccard dedup — a v1.7.6 pre-release review
// found the pre-fix version (raw word overlap, no stopword stripping) silently dropped
// genuinely different facts of the same shape ("I live in Paris" vs "I live in Berlin").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDuplicateFact } from './memory.js'

test('a fact with no prior facts is never a duplicate', () => {
  assert.equal(isDuplicateFact([], 'The user lives in Berlin.'), false)
})

test('an exact repeat is a duplicate', () => {
  assert.equal(isDuplicateFact(['The user lives in Berlin.'], 'The user lives in Berlin.'), true)
})

test('a case/punctuation-only variant is a duplicate', () => {
  assert.equal(isDuplicateFact(['The user lives in Berlin.'], 'the user lives in berlin'), true)
})

test('one fact containing the other is a duplicate', () => {
  assert.equal(isDuplicateFact(['My name is Alice.'], 'My name is Alice Smith.'), true)
})

test('facts differing only in the one word that matters are NOT duplicates', () => {
  // These four pairs are the exact failure cases the pre-fix Jaccard-on-raw-words
  // comparison collapsed to "duplicate" — stopwords dominated the overlap score.
  assert.equal(isDuplicateFact(['I live in Paris.'], 'I live in Berlin.'), false)
  assert.equal(isDuplicateFact(['My name is Alice.'], 'My name is Bob.'), false)
  assert.equal(isDuplicateFact(['I work as a teacher.'], 'I work as a nurse.'), false)
  assert.equal(isDuplicateFact(['I use a Mac.'], 'I use a PC.'), false)
})

test('a genuinely reworded duplicate is still caught via word overlap', () => {
  assert.equal(
    isDuplicateFact(['The user has an RTX 5070 Ti GPU.'], 'User has an RTX 5070 Ti GPU.'),
    true,
  )
})
