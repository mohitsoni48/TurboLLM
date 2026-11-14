// What llama-server's /props says about the loaded model's modalities: the chat offers a recording as audio only on
// this answer, so a wrong read either hides the option or sends audio to a model that cannot hear it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { audioInputFromProps, probeAudioInput } from './modalities'

test('audioInputFromProps reads modalities.audio, and a build that predates audio input cannot take it', () => {
  assert.equal(audioInputFromProps({ modalities: { vision: true, audio: true } }), true)
  assert.equal(audioInputFromProps({ modalities: { vision: true } }), false)
  assert.equal(audioInputFromProps({ modalities: { audio: false } }), false)
})

test('audioInputFromProps is null when the body does not say either way', () => {
  for (const body of [{}, null, 'x', undefined, 7, { modalities: null }, { modalities: 'audio' }]) {
    assert.equal(audioInputFromProps(body), null, JSON.stringify(body))
  }
})

test('probeAudioInput asks the engine\'s own /props and returns the parsed answer', async () => {
  const urls: string[] = []
  const fetchImpl = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ modalities: { audio: true } }), { status: 200 })
  }) as unknown as typeof fetch
  assert.equal(await probeAudioInput(8123, fetchImpl), true)
  assert.deepEqual(urls, ['http://127.0.0.1:8123/props'])
})

test('probeAudioInput is null for an engine with no /props, a failing request or an unreadable body', async () => {
  const answer = (make: () => Response | Promise<Response>) => (async () => make()) as unknown as typeof fetch
  assert.equal(await probeAudioInput(1, answer(() => new Response('nope', { status: 404 }))), null)
  assert.equal(await probeAudioInput(1, answer(() => { throw new Error('ECONNREFUSED') })), null)
  assert.equal(await probeAudioInput(1, answer(() => new Response('<html>', { status: 200 }))), null)
})
