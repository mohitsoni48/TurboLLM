import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { ValueError } from '../config/config'
import { NotFoundError } from '../engines/registry'
import { body, err, jsonBody, regErr } from './http'

function echo(read: (c: never) => Promise<unknown>) {
  const app = new Hono()
  app.post('/', async (c) => c.json({ got: await read(c as never) }))
  return (raw: string) => app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })
}

test('err answers the error envelope with the given status', async () => {
  const app = new Hono()
  app.get('/', (c) => err(c, 409, 'busy', 'Wait.'))
  const res = await app.request('/')
  assert.equal(res.status, 409)
  assert.deepEqual(await res.json(), { error: { code: 'busy', message: 'Wait.' } })
})

test('jsonBody returns any JSON value, and {} for a body that does not parse', async () => {
  const send = echo(jsonBody)
  assert.deepEqual(await (await send('[1,2]')).json(), { got: [1, 2] })
  assert.deepEqual(await (await send('not json')).json(), { got: {} })
})

test('body returns an object body as is, and {} for null, an array or a primitive', async () => {
  const send = echo(body)
  assert.deepEqual(await (await send('{"a":1}')).json(), { got: { a: 1 } })
  for (const raw of ['null', '[1]', '7', 'not json']) assert.deepEqual(await (await send(raw)).json(), { got: {} })
})

test('regErr maps a missing engine to 404, a bad value to 400 and anything else to 500', async () => {
  const app = new Hono()
  app.get('/:kind', (c) => {
    const kind = c.req.param('kind')
    return regErr(c, kind === 'missing' ? new NotFoundError() : kind === 'bad' ? new ValueError('port', 'must be a number') : new Error('boom'))
  })
  assert.equal((await app.request('/missing')).status, 404)
  const bad = await app.request('/bad')
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { error: { code: 'invalid_config_value', message: new ValueError('port', 'must be a number').message } })
  assert.equal((await app.request('/other')).status, 500)
})
