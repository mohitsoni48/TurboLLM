// The primitives every Jev endpoint shares (ADR-434 (d), ADR-436 (3)). `./jev-serving` is deliberately the
// FIRST local import: it and `./gateway` import each other, so loading it first proves that no module of
// that cycle reads another member's binding at module top level.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import * as serving from './jev-serving'
import { JevShapeError } from '../models/jev'

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
