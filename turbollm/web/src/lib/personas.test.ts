import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgents, buildSystemPrompt } from './personas'

// GitHub #52: "the model still is being fed tool instructions even in the blank template
// (which should not include a thing for 'raw' model response)". Blank's whole point is zero
// injected instructions — that has to include the tool-calling preamble many chat templates
// render whenever ANY tools are offered, not just the system prompt text.

test('resolveAgents: Blank resolves to an explicit empty tool list, not unrestricted', () => {
  const agents = resolveAgents([], {})
  const blank = agents.find((a) => a.id === 'blank')
  assert.ok(blank)
  assert.deepEqual(blank!.tools, [])
})

test('resolveAgents: an untouched built-in (e.g. Concise) stays unrestricted (tools undefined)', () => {
  const agents = resolveAgents([], {})
  const concise = agents.find((a) => a.id === 'concise')
  assert.ok(concise)
  assert.equal(concise!.tools, undefined)
})

test('resolveAgents: a saved override wins over the built-in default, even for Blank', () => {
  const agents = resolveAgents([], { blank: { tools: ['read', 'grep'] } })
  const blank = agents.find((a) => a.id === 'blank')
  assert.deepEqual(blank!.tools, ['read', 'grep'])
})

test('resolveAgents: an override that explicitly restricts to zero tools stays zero (not undefined)', () => {
  const agents = resolveAgents([], { concise: { tools: [] } })
  const concise = agents.find((a) => a.id === 'concise')
  assert.deepEqual(concise!.tools, [])
})

test('buildSystemPrompt: blank agent still returns an empty system prompt (unchanged)', () => {
  assert.equal(buildSystemPrompt('blank', 'ignored', { assistantName: '', userName: '', customInstructions: '' }), '')
})

// ADR-434 (d): the in-app assistant describes TurboLLM's gateway from this text, so it has to name the
// Jev endpoints, or it will tell a user there is no way to classify, rerank or run System One.
test('the TurboLLM Expert persona lists /v1/systemone, /v1/classify and /v1/rerank in its Gateway section', () => {
  const expert = resolveAgents([], {}).find((a) => a.id === 'expert')
  assert.ok(expert)
  const gateway = expert!.systemPrompt.split('## Gateway')[1].split('\n## ')[0]
  assert.match(gateway, /\*\*OpenAI-compatible\*\*: .*`POST \/v1\/embeddings`, `POST \/v1\/systemone` \(text classification models\), `POST \/v1\/classify`, `POST \/v1\/rerank` \(Jev models only\)/)
})

// ADR-444: one name, "text classification", then the two runtimes behind it.
test('the TurboLLM Expert persona names text classification once, then its two runtimes and where to find them', () => {
  const expert = resolveAgents([], {}).find((a) => a.id === 'expert')
  assert.ok(expert)
  const gateway = expert!.systemPrompt.split('## Gateway')[1].split('\n## ')[0]
  assert.match(gateway, /Jev models are NLI cross-encoders served by vLLM/)
  assert.match(gateway, /Laya models run on their own Laya engine/)
  assert.match(gateway, /Discover's Text classification category finds both/)
})

// The in-app assistant explains downloads from this text: Pause keeps a download, a paused one's Discard deletes its
// partial, and the "all" buttons leave what they should alone. It still said only an interrupted download comes back
// paused, and that Cancel deletes the partial, with no word of Pause, Discard or Pause all.
test('the TurboLLM Expert persona says Pause keeps a download across a restart, Discard deletes a paused one\'s partial, and Cancel all leaves paused ones alone', () => {
  const expert = resolveAgents([], {}).find((a) => a.id === 'expert')
  assert.ok(expert)
  const downloads = expert!.systemPrompt.split('**Pause and Resume**')[1]?.split('\n')[0] ?? ''
  assert.match(downloads, /\*\*Pause\*\* \(or \*\*Pause all\*\*\) stops a download and keeps what it has downloaded, also across a daemon restart/)
  assert.match(downloads, /\*\*Resume\*\* \(or \*\*Resume all\*\*\) continues from that exact byte/)
  assert.match(downloads, /A paused or failed download offers \*\*Discard\*\*, which deletes its partial file \(it asks first above 50 MB\)/)
  assert.match(downloads, /\*\*Cancel all\*\* leaves paused downloads alone, and \*\*Dismiss all\*\* clears only finished and cancelled rows/)
})

// getDefaultAgentId/getConvAgentId's isAndroid fallback (personas.ts) isn't covered here: both
// read/write `localStorage`, which this suite's node:test runner (tsx --test, no
// --localstorage-file) only stubs — setItem/removeItem are undefined, so any test touching them
// throws rather than exercising real behavior. Verified by hand instead (tsc + a manual read of
// the two call sites) — see ChatScreen.tsx/AgentsLibrary.tsx's isAndroid wiring.
