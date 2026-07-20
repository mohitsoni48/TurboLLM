// F-021: tests for the deterministic retrieval service.
// Pure functions + injected fetch — no network, fully deterministic.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  research,
  keywordOverlap,
  domainScore,
  extractPassage,
  officialSourceBoost,
  officialDocsBoost,
  aggregatorPenalty,
  sourceQuality,
  MAX_PASSAGE_CHARS,
  type ResearchQuery,
} from './research-service.js'
import type { SearchConfig, FetchImpl } from './search-providers.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function stubFetch(results: Array<{ title?: string; url?: string; content?: string; score?: number }>): FetchImpl {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results }),
    text: async () => JSON.stringify({ results }),
  })) as unknown as FetchImpl
}

const CFG: SearchConfig = { provider: 'tavily', tavilyApiKey: 'test-key' }

// ── keywordOverlap ────────────────────────────────────────────────────────────

test('keywordOverlap: identical query and text returns 1', () => {
  const score = keywordOverlap('machine learning', 'machine learning')
  assert.ok(score > 0.9, `expected ≥0.9, got ${score}`)
})

test('keywordOverlap: no matching terms returns 0', () => {
  const score = keywordOverlap('machine learning', 'cooking recipes dessert')
  assert.equal(score, 0)
})

test('keywordOverlap: partial match returns between 0 and 1', () => {
  const score = keywordOverlap('python programming', 'python is great for programming tasks')
  assert.ok(score > 0 && score <= 1, `expected (0,1], got ${score}`)
})

test('keywordOverlap: case insensitive', () => {
  const s1 = keywordOverlap('Python', 'python programming')
  const s2 = keywordOverlap('python', 'Python programming')
  assert.equal(s1, s2)
})

// ── domainScore ───────────────────────────────────────────────────────────────

test('domainScore: wikipedia gets high score', () => {
  assert.ok(domainScore('https://en.wikipedia.org/wiki/Foo') >= 0.8)
})

test('domainScore: .edu gets high score', () => {
  assert.ok(domainScore('https://mit.edu/courses/ai') >= 0.8)
})

test('domainScore: .gov gets high score', () => {
  assert.ok(domainScore('https://cdc.gov/diseases') >= 0.8)
})

test('domainScore: unknown domain gets 0.5', () => {
  assert.equal(domainScore('https://random-unknown-blog.xyz/post'), 0.5)
})

test('domainScore: known spam domain gets low score', () => {
  assert.ok(domainScore('https://pinterest.com/pin/12345') <= 0.2)
})

// ── extractPassage ────────────────────────────────────────────────────────────

test('extractPassage: picks sentence with best keyword overlap', () => {
  const content = 'The sky is blue. Python is a programming language. Cats are fluffy.'
  const passage = extractPassage('python programming', content)
  assert.ok(passage.toLowerCase().includes('python'), `expected python in passage, got: "${passage}"`)
})

// Was 'falls back to first 200 chars'. The one-sentence/200-char cap was the starvation half
// of the stale-research bug (ADR-230): it is now the full MAX_PASSAGE_CHARS budget.
test('extractPassage: falls back to the excerpt budget when content has no sentence boundary', () => {
  const content = 'a'.repeat(3000)
  const passage = extractPassage('query', content)
  assert.equal(passage, content.slice(0, MAX_PASSAGE_CHARS))
})

test('extractPassage: handles empty content', () => {
  const passage = extractPassage('query', '')
  assert.equal(passage, '')
})

test('extractPassage: single sentence returns that sentence', () => {
  const content = 'The quick brown fox jumps over the lazy dog'
  const passage = extractPassage('fox lazy dog', content)
  assert.ok(passage.length > 0)
})

// ── scoring and ranking ───────────────────────────────────────────────────────

test('research: results are sorted by relevanceScore descending', async () => {
  const fetch = stubFetch([
    { title: 'Cooking recipes', url: 'https://unknown1.com', content: 'Cooking recipes for dinner party events.' },
    { title: 'Python programming tutorial', url: 'https://python.org/docs', content: 'Python is a great programming language for developers.' },
    { title: 'Python basics', url: 'https://en.wikipedia.org/wiki/Python', content: 'Python programming language was created by Guido.' },
  ])
  const q: ResearchQuery = { query: 'python programming' }
  const results = await research(q, CFG, fetch)
  assert.ok(results.length >= 2)
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].relevanceScore >= results[i].relevanceScore,
      `result[${i - 1}].score (${results[i-1].relevanceScore}) < result[${i}].score (${results[i].relevanceScore})`,
    )
  }
})

// Was 'caps at 5 results'. MAX_RESULTS is 8 — ADR-230 trades payload size for coverage.
test('research: caps at 8 results', async () => {
  const fetch = stubFetch(
    Array.from({ length: 10 }, (_, i) => ({
      title: `Python result ${i}`,
      url: `https://python${i}.org`,
      content: `Python programming tutorial number ${i} for python developers.`,
    })),
  )
  const q: ResearchQuery = { query: 'python programming' }
  const results = await research(q, CFG, fetch)
  assert.ok(results.length <= 8, `expected ≤8 results, got ${results.length}`)
})

test('research: domain extracted correctly', async () => {
  const fetch = stubFetch([
    { title: 'Python docs', url: 'https://python.org/docs/latest', content: 'Python programming language documentation.' },
  ])
  const q: ResearchQuery = { query: 'python' }
  const results = await research(q, CFG, fetch)
  assert.ok(results.length > 0)
  assert.equal(results[0].domain, 'python.org')
})

test('research: passage is extracted (non-empty for non-empty content)', async () => {
  const fetch = stubFetch([
    {
      title: 'Python programming',
      url: 'https://python.org',
      content: 'Python is a high-level language. It is great for programming. Many developers love Python.',
    },
  ])
  const q: ResearchQuery = { query: 'python programming' }
  const results = await research(q, CFG, fetch)
  assert.ok(results.length > 0)
  assert.ok(results[0].passage.length > 0, 'passage should be non-empty')
})

test('research: freshnessSignal is a valid value', async () => {
  const fetch = stubFetch([
    { title: 'Python docs', url: 'https://python.org', content: 'Python programming is great.' },
  ])
  const q: ResearchQuery = { query: 'python' }
  const results = await research(q, CFG, fetch)
  if (results.length > 0) {
    assert.ok(['recent', 'dated', 'unknown'].includes(results[0].freshnessSignal))
  }
})

test('research: returns empty array when provider not configured', async () => {
  const badCfg: SearchConfig = { provider: 'tavily' } // no key
  const q: ResearchQuery = { query: 'python' }
  const results = await research(q, badCfg)
  assert.deepEqual(results, [])
})

test('research: wikipedia result scores higher than unknown domain for identical content', async () => {
  const fetch = stubFetch([
    { title: 'Python', url: 'https://unknownblog.xyz/python', content: 'Python programming language overview.' },
    { title: 'Python', url: 'https://en.wikipedia.org/wiki/Python', content: 'Python programming language overview.' },
  ])
  const q: ResearchQuery = { query: 'python programming' }
  const results = await research(q, CFG, fetch)
  const wikiResult = results.find((r) => r.url.includes('wikipedia'))
  const unknownResult = results.find((r) => r.url.includes('unknownblog'))
  if (wikiResult && unknownResult) {
    assert.ok(
      wikiResult.relevanceScore > unknownResult.relevanceScore,
      `wiki (${wikiResult.relevanceScore}) should outscore unknown (${unknownResult.relevanceScore})`,
    )
  }
})

test('research: configured-provider plumbing — fetch is called with tavily endpoint', async () => {
  const calls: string[] = []
  const trackingFetch: FetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ title: 'T', url: 'https://python.org', content: 'python test' }] }),
      text: async () => '{}',
    } as Response
  }) as unknown as FetchImpl

  const q: ResearchQuery = { query: 'python' }
  await research(q, CFG, trackingFetch)
  assert.ok(calls.length > 0)
  assert.match(calls[0], /tavily\.com/)
})

// ── Source-quality signals ────────────────────────────────────────────────────
//
// ⚠️ These signals must be STRUCTURAL and topic-agnostic (founder directive: "this should be
// a universal fix for research unrelated to LLM or even non tech"). The examples below are
// deliberately medicine / sport / travel / cooking / consumer-goods. If you are here to make
// research work better for a technical query, add a NON-technical case alongside it — a rule
// that only helps technology queries is the wrong rule.

// ── officialSourceBoost ───────────────────────────────────────────────────────

test('officialSourceBoost: entity name is the hostname (consumer goods)', () => {
  assert.equal(officialSourceBoost('Tesla Model 3 range', 'https://www.tesla.com/model3'), 0.25)
})

test('officialSourceBoost: entity name is the hostname (medicine)', () => {
  assert.equal(officialSourceBoost('Ozempic side effects', 'https://www.ozempic.com/side-effects.html'), 0.25)
})

test('officialSourceBoost: uppercase acronym matches a short hostname label (health authority)', () => {
  // "nhs" is 3 chars, below the distinctive-token floor — the capitalisation is what earns it.
  assert.equal(officialSourceBoost('NHS blood pressure guidance', 'https://www.nhs.uk/conditions/high-blood-pressure/'), 0.25)
})

test('officialSourceBoost: uppercase acronym matches (sport governing body)', () => {
  assert.equal(officialSourceBoost('FIFA World Cup 1974 winner', 'https://www.fifa.com/tournaments/mens/worldcup/1974'), 0.25)
})

test('officialSourceBoost: official page on a shared platform scores lower than an own domain', () => {
  const platform = officialSourceBoost('Michelin restaurant guide Tokyo', 'https://www.instagram.com/michelin')
  assert.equal(platform, 0.15)
  assert.ok(platform < officialSourceBoost('Michelin restaurant guide Tokyo', 'https://guide.michelin.com/'))
})

test('officialSourceBoost: version digits are tolerated on either side', () => {
  // Users type the version; the entity's own site usually does not carry it.
  assert.ok(officialSourceBoost('Qwen3.6 context length', 'https://huggingface.co/Qwen') > 0)
})

test('officialSourceBoost: content farm with the entity name embedded in its domain gets nothing', () => {
  // The critical false positive: substring matching would hand this the full boost.
  assert.equal(officialSourceBoost('Tesla Model 3 range', 'https://bestteslacars.com/blog/best-tesla-deals'), 0)
})

test('officialSourceBoost: generic SEO words never count as an entity name', () => {
  assert.equal(officialSourceBoost('best time to visit Japan', 'https://best.com/japan'), 0)
})

test('officialSourceBoost: a topical category route is not an official page', () => {
  // "/<query term>" is far more often a farm's topic route than an entity's account page,
  // so a deep slug or an SEO-shaped host disqualifies the path signal.
  assert.equal(officialSourceBoost('best time to visit Japan', 'https://travelguides.com/japan/best-time-to-visit'), 0)
  assert.equal(officialSourceBoost('best time to visit Japan', 'https://travelguides.com/best/japan'), 0)
})

test('officialSourceBoost: short/stopword query terms do not fire', () => {
  assert.equal(officialSourceBoost('the best time to visit Japan', 'https://the.co.uk/travel'), 0)
})

test('officialSourceBoost: unrelated domain gets nothing', () => {
  assert.equal(officialSourceBoost('plantar fasciitis treatment', 'https://footcarereviews.net/treatments'), 0)
})

test('officialSourceBoost: malformed url does not throw', () => {
  assert.equal(officialSourceBoost('tesla range', 'not a url at all'), 0)
})

// ── officialDocsBoost ─────────────────────────────────────────────────────────

test('officialDocsBoost: support/help subdomains are first-party in any industry', () => {
  assert.ok(officialDocsBoost('https://support.apple.com/en-us/HT201236') > 0)
  assert.ok(officialDocsBoost('https://help.netflix.com/en/node/407') > 0)
  assert.ok(officialDocsBoost('https://docs.stripe.com/payments') > 0)
})

test('officialDocsBoost: ordinary hostnames get nothing', () => {
  assert.equal(officialDocsBoost('https://www.mayoclinic.org/diseases'), 0)
  assert.equal(officialDocsBoost('https://helpfulrecipes.com/soup'), 0)
})

// ── aggregatorPenalty ─────────────────────────────────────────────────────────

test('aggregatorPenalty: listicle title fires (consumer goods)', () => {
  assert.ok(aggregatorPenalty('Best Mattresses of 2026, Tested and Reviewed', 'https://sleepblog.com/best-mattresses-2026') > 0)
})

test('aggregatorPenalty: listicle title fires (diet/health)', () => {
  assert.ok(aggregatorPenalty('Top 10 Diets Ranked by Nutritionists', 'https://wellnesshub.net/top-10-diets-ranked') > 0)
})

test('aggregatorPenalty: fires on the URL slug even when the title is plain', () => {
  assert.ok(aggregatorPenalty('Mattress guidance', 'https://sleepblog.com/blog/best-mattresses-for-back-pain-ranked') > 0)
})

test('aggregatorPenalty: annual-refresh signature costs slightly more than a bare listicle', () => {
  const withYear = aggregatorPenalty('Best Hiking Boots in 2026', 'https://gearsite.com/x')
  const withoutYear = aggregatorPenalty('Best Hiking Boots', 'https://gearsite.com/x')
  assert.ok(withYear > withoutYear)
})

test('aggregatorPenalty: primary source is untouched', () => {
  assert.equal(aggregatorPenalty('Plantar fasciitis', 'https://www.nhs.uk/conditions/plantar-fasciitis/'), 0)
  assert.equal(aggregatorPenalty('1974 FIFA World Cup', 'https://en.wikipedia.org/wiki/1974_FIFA_World_Cup'), 0)
})

test('aggregatorPenalty: skipped for an explicit comparison request', () => {
  const title = 'Best Mattresses of 2026, Tested and Reviewed'
  const url = 'https://sleepblog.com/best-mattresses-2026'
  assert.ok(aggregatorPenalty(title, url) > 0)
  assert.equal(aggregatorPenalty(title, url, 'comparison'), 0)
})

test('aggregatorPenalty: a systematic review is a primary source, not a roundup', () => {
  assert.equal(
    aggregatorPenalty('A systematic review of plantar fasciitis treatments', 'https://pubmed.ncbi.nlm.nih.gov/12345/'),
    0,
  )
})

test('aggregatorPenalty: "best practices" is documentation language, not a listicle', () => {
  assert.equal(aggregatorPenalty('Food safety best practices', 'https://www.fda.gov/food/food-safety-best-practices'), 0)
})

test('aggregatorPenalty: never a kill — stays mild', () => {
  assert.ok(aggregatorPenalty('Best Top 10 Ultimate Guide Ranked Reviews 2026', 'https://spam.com/best-top-10-ranked-2026') <= 0.2)
})

// ── sourceQuality ─────────────────────────────────────────────────────────────

test('sourceQuality: official source beats a keyword-matched content farm (medicine)', () => {
  const official = sourceQuality('Ozempic side effects', 'Ozempic (semaglutide) injection', 'https://www.ozempic.com/about/side-effects.html')
  const farm = sourceQuality('Ozempic side effects', 'Top 10 Ozempic Side Effects Reviewed in 2026', 'https://healthyliving-tips.com/blog/top-10-ozempic-side-effects')
  assert.ok(official > farm, `official (${official}) should beat farm (${farm})`)
})

test('sourceQuality: stays within 0.1–1.0', () => {
  const high = sourceQuality('NHS blood pressure', 'Blood pressure', 'https://www.nhs.uk/conditions/high-blood-pressure/')
  const low = sourceQuality('mattress', 'Best Mattresses Ranked 2026', 'https://pinterest.com/pin/best-mattresses-ranked-2026')
  assert.ok(high <= 1.0 && high >= 0.1)
  assert.ok(low <= 1.0 && low >= 0.1)
})

test('sourceQuality: does not throw on a malformed url', () => {
  assert.doesNotThrow(() => sourceQuality('q', 't', '::::not-a-url'))
})

// ── richer excerpts (the starvation half) ─────────────────────────────────────

test('extractPassage: returns several sentences, not one (history)', () => {
  const content =
    'The tournament was held in West Germany. The 1974 World Cup final took place in Munich on 7 July. ' +
    'West Germany beat the Netherlands 2-1 to win the trophy. Gerd Muller scored the winning goal. ' +
    'Johan Neeskens had opened the scoring from the penalty spot.'
  const passage = extractPassage('who won the 1974 world cup final', content)
  assert.ok(passage.includes('Munich'), `expected the best sentence, got: "${passage}"`)
  assert.ok(passage.includes('Netherlands'), `expected expansion into neighbours, got: "${passage}"`)
  assert.ok(passage.length > 120, `expected a multi-sentence excerpt, got ${passage.length} chars`)
})

test('extractPassage: short content is returned whole (cooking)', () => {
  const content = 'Feed a sourdough starter once a day. Use equal weights of flour and water. Discard half before each feed.'
  assert.equal(extractPassage('sourdough starter feeding schedule', content), content)
})

test('extractPassage: never exceeds the excerpt budget', () => {
  const content = Array.from(
    { length: 60 },
    (_, i) => `Plantar fasciitis treatment option number ${i} involves stretching and rest for the affected heel.`,
  ).join(' ')
  const passage = extractPassage('plantar fasciitis treatment', content)
  assert.ok(passage.length <= MAX_PASSAGE_CHARS, `expected ≤${MAX_PASSAGE_CHARS}, got ${passage.length}`)
  assert.ok(passage.length > 300, `expected a generous excerpt, got ${passage.length} chars`)
})

test('extractPassage: pulls in the preceding sentence when the best one refers backwards', () => {
  const content =
    'Cabin bags must fit under the seat in front of you. Ryanair allows one small personal bag free of charge. ' +
    'It must not exceed 40x20x25 cm.'
  const passage = extractPassage('ryanair cabin bag size limit', content)
  assert.ok(passage.includes('40x20x25'), `expected the sizing sentence, got: "${passage}"`)
  assert.ok(passage.includes('Ryanair'), `expected the antecedent for "It", got: "${passage}"`)
})

// ── end-to-end: the new signals actually move the ranking ─────────────────────

test('research: plain source outranks a listicle with identical content (cooking)', async () => {
  const content = 'Feed a sourdough starter once a day with equal weights of flour and water. A stable feeding schedule keeps it active.'
  const fetch = stubFetch([
    { title: 'Best Sourdough Starter Feeding Schedules Ranked 2026', url: 'https://bakingblog.net/best-sourdough-starter-feeding', content },
    { title: 'Sourdough starter feeding schedule', url: 'https://bakingscience.org/sourdough-starter-feeding', content },
  ])
  const results = await research({ query: 'sourdough starter feeding schedule' }, CFG, fetch)
  assert.equal(results[0].domain, 'bakingscience.org', `listicle should not rank first: ${JSON.stringify(results.map((r) => r.domain))}`)
})

test('research: the entity\'s own site outranks a third party with identical content', async () => {
  const content = 'The Model 3 has an EPA estimated range of 363 miles on the Long Range trim.'
  const fetch = stubFetch([
    { title: 'Model 3', url: 'https://evbuyersguide.com/model3', content },
    { title: 'Model 3', url: 'https://www.tesla.com/model3', content },
  ])
  const results = await research({ query: 'Tesla Model 3 range' }, CFG, fetch)
  assert.equal(results[0].domain, 'tesla.com', `official site should rank first: ${JSON.stringify(results.map((r) => r.domain))}`)
})

test('research: comparison intent stops the listicle penalty from reordering results', async () => {
  const content = 'Memory foam and innerspring mattresses differ in support, cooling and durability.'
  const fetch = stubFetch([
    { title: 'Best Mattresses Compared and Ranked 2026', url: 'https://sleepblog.net/best-mattresses-ranked', content },
    { title: 'Mattress types', url: 'https://sleepscience.org/mattress-types', content },
  ])
  const penalised = await research({ query: 'memory foam vs innerspring mattress' }, CFG, fetch)
  const exempt = await research({ query: 'memory foam vs innerspring mattress', intent: 'comparison' }, CFG, fetch)
  const scoreOf = (rs: Awaited<ReturnType<typeof research>>, host: string) => rs.find((r) => r.domain === host)?.relevanceScore ?? 0
  assert.ok(
    scoreOf(exempt, 'sleepblog.net') > scoreOf(penalised, 'sleepblog.net'),
    'comparison intent should lift the roundup back up',
  )
})
