// The distiller's and the reviewer's JSON request (json-completion.ts). A LiteRT-LM model is not sent response_format
// json_object, which took LFM2.5 off the way it writes JSON ({"name":", "} instead of the skill); and a request the
// model could not be asked says why, instead of reading as "nothing found" (a skill saved from a conversation reported
// "No clear reusable skill found", a folder "No skills found", when the engine had refused every request).
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { hashKey } from '../auth'
import { defaultConfig } from '../config/config'
import type { Deps } from '../deps'
import { registerAgentRoutes } from './agent-routes'
import { distillFromConversation } from './distiller'
import { reviewConversation } from './reviewer'
import { saveSkillFromConversation } from './skill-jobs'
import { AgentTaskState } from './task-state'
import { tmpDir } from '../test-support/tmp'

const SKILL = '{"name": "csv-summary", "description": "Summarise a CSV.", "procedure": "1. Read it.\\n2. Sum it."}'
const RAW_KEY = 'tllm-jsoncompletionjsoncompletionjsonco1'

function deps(kind = 'litert-lm', opts: { running?: boolean } = {}): Deps {
  const cfg = defaultConfig()
  cfg.apiKeys.push({ id: 'k1', name: 'mine', hash: hashKey(RAW_KEY), prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null })
  const dir = tmpDir('json-completion-')
  return {
    manager: {
      status: () => opts.running === false ? { state: 'stopped', model: null } : { state: 'running', model: { key: 'm', name: 'M', ctx: 4096 } },
      target: () => opts.running === false ? null : 'http://engine.invalid',
      currentOpts: () => ({ modelPath: '/models/m.litertlm' }),
    },
    registry: { active: () => ({ kind }) },
    store: { snapshot: () => cfg, dir: () => dir },
  } as unknown as Deps
}

/** The engine answers each request with the next of `answers`; records what each was sent. */
function engine(t: TestContext, answers: Array<() => Response>): Array<Record<string, unknown>> {
  const original = globalThis.fetch
  const sent: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return answers[Math.min(sent.length - 1, answers.length - 1)]()
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return sent
}

const ok = (content: string) => () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
/** LiteRT-LM's servers give the reason in the status line, with no body. */
const refused = (status: number, statusText: string) => () => new Response(null, { status, statusText })

test('a LiteRT-LM model is not sent response_format: it writes its JSON its own way, which is read; llama.cpp still gets it', async (t) => {
  // What LFM2.5-230M writes without the constraint: a fenced, indented object.
  const sent = engine(t, [ok('```json\n' + SKILL + '\n```')])
  const s = await distillFromConversation(deps('litert-lm'), [{ role: 'user', content: 'sum this csv' }])
  assert.equal(s.name, 'csv-summary')
  assert.equal('response_format' in sent[0], false)
  const r = await reviewConversation(deps('litert-lm'), [{ role: 'user', content: 'x' }])
  assert.equal(r.error, undefined)
  assert.equal('response_format' in sent[1], false)
  // Thinking off still reaches it, as reasoning_effort none.
  assert.equal(sent[1].reasoning_effort, 'none')

  await distillFromConversation(deps('llama.cpp'), [{ role: 'user', content: 'sum this csv' }])
  await reviewConversation(deps('llama.cpp'), [{ role: 'user', content: 'x' }])
  assert.deepEqual(sent[2].response_format, { type: 'json_object' })
  assert.deepEqual(sent[3].response_format, { type: 'json_object' })
})

test('a request the engine refuses says why, as does no model loaded: the distiller and the reviewer', async (t) => {
  // The distiller's and the reviewer's requests are refused; the third is answered.
  const refusal = refused(500, 'RuntimeError: Failed to create conversation')
  const sent = engine(t, [refusal, refusal, ok('{"name": null, "description": null, "procedure": null}')])
  const s = await distillFromConversation(deps(), [{ role: 'user', content: 'sum this csv' }])
  assert.equal(s.name, null)
  assert.equal(s.error, 'Engine returned 500: RuntimeError: Failed to create conversation')
  assert.equal(sent.length, 1, 'asked once')
  const r = await reviewConversation(deps(), [{ role: 'user', content: 'x' }])
  assert.equal(r.lesson, null)
  assert.equal(r.error, 'Engine returned 500: RuntimeError: Failed to create conversation')

  assert.equal((await distillFromConversation(deps('litert-lm', { running: false }), [{ role: 'user', content: 'x' }])).error, 'No model loaded.')
  assert.equal((await reviewConversation(deps('litert-lm', { running: false }), [{ role: 'user', content: 'x' }])).error, 'No model loaded.')
  // A model that answers with nothing reusable is still "nothing found", not an error.
  const none = await distillFromConversation(deps(), [{ role: 'user', content: 'hi' }])
  assert.equal(none.name, null)
  assert.equal(none.error, undefined)
})

/** Waits (bounded) for a background task to finish. */
async function settled(tasks: AgentTaskState, id: string) {
  for (let i = 0; i < 400 && tasks.get(id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
  return tasks.get(id)
}

test('a skill saved from a conversation the engine refused fails with the reason, not "No clear reusable skill found"', async (t) => {
  engine(t, [refused(500, 'RuntimeError: Failed to create conversation')])
  const tasks = new AgentTaskState()
  const d = { ...deps(), agentTasks: tasks, db: { getConversation: () => ({ id: 'c1', agentId: '', messages: [{ role: 'user', content: 'sum this csv' }] }) } } as unknown as Deps
  const task = await settled(tasks, saveSkillFromConversation(d, 'c1')!)
  assert.equal(task?.status, 'failed')
  assert.equal(task?.error, 'Could not write a skill: Engine returned 500: RuntimeError: Failed to create conversation')
})

test('learning from a folder the engine refused fails with the reason, not "No skills found in that folder."', async (t) => {
  engine(t, [refused(500, 'RuntimeError: Failed to create conversation')])
  const folder = tmpDir('json-completion-folder-')
  mkdirSync(join(folder, 'notes'))
  writeFileSync(join(folder, 'notes', 'csv.md'), 'To total a CSV per region: read it, group by region, sum the amounts.')
  const tasks = new AgentTaskState()
  const d = { ...deps(), agentTasks: tasks } as unknown as Deps
  const app = new Hono()
  registerAgentRoutes(app, d)
  const res = await app.request('/api/v1/skills/learn-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RAW_KEY}` },
    body: JSON.stringify({ folder }),
  })
  assert.equal(res.status, 200)
  const id = tasks.list()[0]?.id
  assert.ok(id)
  const task = await settled(tasks, id)
  assert.equal(task?.status, 'failed')
  assert.equal(task?.error, 'Could not learn skills from the folder: 1 file could not be read by the model ' +
    '(csv.md: Engine returned 500: RuntimeError: Failed to create conversation)')
})
