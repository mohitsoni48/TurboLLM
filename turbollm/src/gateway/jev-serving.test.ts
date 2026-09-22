// The primitives every Jev endpoint shares (ADR-434 (d), ADR-436 (3)). `./jev-serving` is deliberately the
// FIRST local import: it and `./gateway` import each other, so loading it first proves that no module of
// that cycle reads another member's binding at module top level.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import * as serving from './jev-serving'
import { JevShapeError } from '../models/jev'
import type { ModelEntry } from '../models/scanner'

test('the shared primitives are exported as functions', () => {
  const functions = [
    serving.callEngineClassify,
    serving.nliTemplateFor,
    serving.jevErrorResponse,
    serving.jsonBodyOf,
    serving.throwIfRefused,
    serving.resolveJevModel,
    serving.routeToJevModel,
    serving.refusalFor,
    serving.isJsonObject,
    serving.JevEndpointError,
  ]
  for (const exported of functions) assert.equal(typeof exported, 'function')
})

test('MAX_JEV_INPUTS is 128', () => {
  assert.equal(serving.MAX_JEV_INPUTS, 128)
})

test('MAX_JEV_INPUT_CHARS is 4000', () => {
  assert.equal(serving.MAX_JEV_INPUT_CHARS, 4000)
})

test('refusalFor gives back the refusal a JevEndpointError carries', () => {
  const refusal: serving.JevHttpError = {
    status: 503,
    code: 'model_not_loaded',
    type: 'api_error',
    message: 'not loaded',
  }
  assert.equal(serving.refusalFor(new serving.JevEndpointError(refusal)), refusal)
})

test('refusalFor answers a JevShapeError with 502 engine_bad_response', () => {
  assert.deepEqual(serving.refusalFor(new JevShapeError('x')), {
    status: 502,
    code: 'engine_bad_response',
    type: 'api_error',
    message: 'The engine returned an unexpected /classify response.',
  })
})

test('refusalFor rethrows any other error, because that is a bug and not a refusal', () => {
  const bug = new Error('bug')
  assert.throws(() => serving.refusalFor(bug), bug)
})

test('isJsonObject accepts a plain object and refuses null, an array, a string and a number', () => {
  assert.equal(serving.isJsonObject({}), true)
  for (const notAnObject of [null, [], 'x', 3]) assert.equal(serving.isJsonObject(notAnObject), false)
})

function appReadingTheBody(): Hono {
  const app = new Hono()
  app.post('/x', async (c) => c.json({ body: (await serving.jsonBodyOf(c)) ?? null }))
  return app
}

function postText(app: Hono, text: string): Promise<Response> {
  return Promise.resolve(app.request('/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
  }))
}

test('jsonBodyOf reads a JSON request body', async () => {
  const res = await postText(appReadingTheBody(), '{"a":1}')
  assert.deepEqual(await res.json(), { body: { a: 1 } })
})

test('jsonBodyOf reads an unparseable request body as no body at all', async () => {
  const res = await postText(appReadingTheBody(), '{bad')
  assert.deepEqual(await res.json(), { body: null })
})

function jev(name: string, sizeBytes: number, verified: boolean): ModelEntry {
  return { key: `${name}|mlx-fp16|${sizeBytes}`, name, sizeBytes, jev: { verified } } as unknown as ModelEntry
}

const CHAT = { key: 'qwen3.6-35b-a3b-q3', name: 'Qwen3.6-35B Q3', sizeBytes: 100 } as unknown as ModelEntry
const JEV_08B = jev('qwen3.5 0.8b nli v2s long', 1_700_000_000, true)
const JEV_35B = jev('qwen3.5 35b a3b nli', 69_000_000_000, false)
const JEV_4B = jev('qwen3.5 4b nli v2', 9_100_000_000, true)
const LIBRARY = [CHAT, JEV_08B, JEV_35B, JEV_4B]

test('isJevLatest matches the alias ignoring case and surrounding whitespace, and nothing longer', () => {
  for (const alias of ['jev-latest', '  JEV-Latest ', 'Jev-Latest\n']) assert.equal(serving.isJevLatest(alias), true)
  for (const other of ['jev-latest2', 'jev latest', '', 'latest']) assert.equal(serving.isJevLatest(other), false)
})

test('resolveJevLatest: an alive verified Jev model wins even when it is smaller than another verified one', () => {
  assert.equal(serving.resolveJevLatest([JEV_08B.key], LIBRARY), JEV_08B)
})

test('resolveJevLatest: an alive unverified Jev model wins over a larger verified one that is not alive', () => {
  assert.equal(serving.resolveJevLatest([JEV_35B.key], LIBRARY), JEV_35B)
})

test('resolveJevLatest: nothing alive picks the largest verified Jev model, not the first by name', () => {
  assert.equal(serving.resolveJevLatest([], LIBRARY), JEV_4B)
})

test('resolveJevLatest: an unverified Jev model never beats a verified one, however large or early', () => {
  assert.equal(serving.resolveJevLatest([], [CHAT, JEV_35B, JEV_4B]), JEV_4B)
})

test('resolveJevLatest: a size tie among verified models goes to library order', () => {
  const first = jev('first', 5_000_000_000, true)
  const second = jev('second', 5_000_000_000, true)
  assert.equal(serving.resolveJevLatest([], [first, second]), first)
  assert.equal(serving.resolveJevLatest([], [second, first]), second)
})

test('resolveJevLatest: with no verified Jev model it picks the largest of all Jev models', () => {
  const small = jev('a', 1_700_000_000, false)
  assert.equal(serving.resolveJevLatest([], [CHAT, small, JEV_35B]), JEV_35B)
})

test('resolveJevLatest: a size tie with no verified Jev model goes to library order', () => {
  const first = jev('first', 5_000_000_000, false)
  const second = jev('second', 5_000_000_000, false)
  assert.equal(serving.resolveJevLatest([], [CHAT, first, second]), first)
})

test('resolveJevLatest: a chat model being the only one alive changes nothing', () => {
  assert.equal(serving.resolveJevLatest([CHAT.key], LIBRARY), JEV_4B)
})

test('resolveJevLatest: with two Jev models alive the first in alive order wins, whatever their sizes', () => {
  assert.equal(serving.resolveJevLatest([JEV_08B.key, JEV_4B.key], LIBRARY), JEV_08B)
  assert.equal(serving.resolveJevLatest([JEV_4B.key, JEV_08B.key], LIBRARY), JEV_4B)
})

test('resolveJevLatest: an alive key that is a chat model or unknown is skipped for the next alive Jev model', () => {
  assert.equal(serving.resolveJevLatest([CHAT.key, 'not in the library', JEV_08B.key], LIBRARY), JEV_08B)
})

test('resolveJevLatest: a library with no Jev model gives undefined', () => {
  assert.equal(serving.resolveJevLatest([], [CHAT]), undefined)
  assert.equal(serving.resolveJevLatest([CHAT.key], [CHAT]), undefined)
})

test('NO_JEV_MODEL_FOR_LATEST is the 404 that names the alias', () => {
  assert.deepEqual(serving.NO_JEV_MODEL_FOR_LATEST, {
    status: 404,
    code: 'model_not_found',
    type: 'invalid_request_error',
    message: "No Jev model in your library for 'jev-latest'.",
  })
})

test('resolveJevLatest neither reorders nor mutates the library or the alive keys', () => {
  const library = Object.freeze([...LIBRARY])
  const alive = Object.freeze([JEV_35B.key, JEV_4B.key])
  serving.resolveJevLatest(alive, library)
  serving.resolveJevLatest([], library)
  assert.deepEqual(library, LIBRARY)
  assert.deepEqual(alive, [JEV_35B.key, JEV_4B.key])
})
