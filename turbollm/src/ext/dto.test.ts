// The public message shape (dto.ts): `include=attachments` is documented as data: URIs (openapi.ts MessageInput), so
// an image the chat store keeps as a file reference (chat/attachments.ts) goes out read back to its data URI.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toMessageDTO, type HeavyField } from './dto'
import type { ChatMessage } from '../chat/store/types'

const REF = `attachment:${'a'.repeat(64)}.png`
const GONE = `attachment:${'b'.repeat(64)}.png`
const files = { inline: async (a: string) => (a === REF ? 'data:image/png;base64,iVBORw0KGgo=' : a === GONE ? null : a) }

const message = (attachments: string[]) => ({
  id: 'm1', chatId: 'c1', seq: 1, role: 'user', content: 'look', status: 'complete', version: 1,
  createdAt: '2026-10-31T00:00:00.000Z', edited: false, attachments,
}) as unknown as ChatMessage

test('include=attachments: references read back to data URIs, inline ones as they are, a missing file left out', async () => {
  const dto = await toMessageDTO(message([REF, 'data:image/jpeg;base64,AAAA', GONE]), new Set<HeavyField>(['attachments']), files)
  assert.deepEqual(dto.attachments, ['data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,AAAA'])
})

test('include=attachments for another tenant: a reference string it posted is returned as stored, never read from disk', async () => {
  let reads = 0
  const dto = await toMessageDTO(message([REF]), new Set<HeavyField>(['attachments']), { inline: async (a) => { reads++; return a } }, 'acme')
  assert.deepEqual(dto.attachments, [REF])
  assert.equal(reads, 0)
})

test('without include=attachments no file is read', async () => {
  let reads = 0
  const dto = await toMessageDTO(message([REF]), new Set<HeavyField>(), { inline: async (a) => { reads++; return a } })
  assert.equal(dto.attachments, undefined)
  assert.equal(reads, 0)
})
