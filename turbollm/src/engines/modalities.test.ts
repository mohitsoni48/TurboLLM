// What llama-server's /props says about the loaded model's modalities: the chat offers a recording as audio only on
// this answer, so a wrong read either hides the option or sends audio to a model that cannot hear it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { audioInputFromProps, audioOutputFromModels, probeAudioInput, probeAudioOutput } from './modalities'

const modelsBody = (output: unknown) => ({ data: [{ id: 'm', architecture: { input_modalities: ['text', 'audio'], output_modalities: output } }] })

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

test('audioOutputFromModels is true on the body a real llama-server answered for an audio-to-audio model', () => {
  const body = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/llamacpp-realtime/v1-models-lfm3-audio.json', import.meta.url)), 'utf8'))
  assert.equal(audioOutputFromModels(body), true)
})

test('audioOutputFromModels needs both text and audio: a text-to-speech model alone says ["audio"]', () => {
  assert.equal(audioOutputFromModels(modelsBody(['text', 'audio'])), true)
  assert.equal(audioOutputFromModels(modelsBody(['audio', 'text'])), true)
  assert.equal(audioOutputFromModels(modelsBody(['audio'])), false)
  assert.equal(audioOutputFromModels(modelsBody(['text'])), false)
  assert.equal(audioOutputFromModels(modelsBody([])), false)
})

test('audioOutputFromModels is null when the body does not list output modalities', () => {
  for (const body of [{}, null, 'x', undefined, 7, { data: [] }, { data: 'x' }, { data: [null] }, { data: [{}] }, { data: [{ architecture: {} }] }, { data: [{ architecture: { output_modalities: 'audio' } }] }]) {
    assert.equal(audioOutputFromModels(body), null, JSON.stringify(body))
  }
})

test('probeAudioOutput asks the engine\'s own /v1/models and returns the parsed answer', async () => {
  const urls: string[] = []
  const fetchImpl = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify(modelsBody(['text', 'audio'])), { status: 200 })
  }) as unknown as typeof fetch
  assert.equal(await probeAudioOutput(8123, fetchImpl), true)
  assert.deepEqual(urls, ['http://127.0.0.1:8123/v1/models'])
})

test('probeAudioOutput is null for a failing request, an error status or an unreadable body', async () => {
  const answer = (make: () => Response | Promise<Response>) => (async () => make()) as unknown as typeof fetch
  assert.equal(await probeAudioOutput(1, answer(() => new Response('nope', { status: 404 }))), null)
  assert.equal(await probeAudioOutput(1, answer(() => { throw new Error('ECONNREFUSED') })), null)
  assert.equal(await probeAudioOutput(1, answer(() => new Response('<html>', { status: 200 }))), null)
})
