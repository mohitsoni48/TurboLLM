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

// Scalability review 2.10: extraction compares each new fact against a bounded window of the
// most recent facts, not every fact ever stored, so its cost stops growing with the table.
test('extraction dedupes against the recent window and never loads every fact', async () => {
  const { ConversationStore, IN_MEMORY_DATA_DIR } = await import('./db.js')
  const { extractMemoryFacts, MEMORY_DEDUPE_WINDOW } = await import('./memory.js')
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const realFetch = globalThis.fetch
  try {
    store.addMemoryFact({ factText: 'I work as a nurse' })
    const windows: number[] = []
    const db = new Proxy(store, {
      get(target, prop) {
        if (prop === 'listMemoryFacts') return () => assert.fail('extraction loaded every fact')
        if (prop === 'recentMemoryFactTexts') return (n: number) => { windows.push(n); return target.recentMemoryFactTexts(n) }
        const v = Reflect.get(target, prop) as unknown
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '- I work as a nurse\n- I live in Pune' } }] }))) as typeof fetch
    const d = { db, manager: { status: () => ({ state: 'running' }) } } as unknown as Parameters<typeof extractMemoryFacts>[0]
    await extractMemoryFacts(d, 'conv-1', 'I work as a nurse and I live in Pune these days', { modelField: 'm', modelName: 'm', ctxMax: 4096, target: 'http://engine.invalid' } as unknown as Parameters<typeof extractMemoryFacts>[3])

    assert.deepEqual(windows, [MEMORY_DEDUPE_WINDOW])
    assert.deepEqual(store.listMemoryFacts().map((f) => f.factText).sort(), ['I live in Pune', 'I work as a nurse'])
  } finally {
    globalThis.fetch = realFetch
    store.close()
  }
})
