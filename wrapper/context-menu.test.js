// context-menu.test.js — plain `node --test`, Node built-ins only.
const test = require('node:test')
const assert = require('node:assert/strict')

const { contextMenuTemplate } = require('./context-menu')

const noActions = { replaceMisspelling: () => {}, copyLink: () => {} }
const allFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const roles = (template) => template.map((item) => item.role || item.type || item.label)

// Issue #302: a right-click in a text field did nothing, so there was no way to paste but Ctrl+V.
test('contextMenuTemplate: a text field gets the edit menu, Paste included', () => {
  const template = contextMenuTemplate({ isEditable: true, editFlags: allFlags }, noActions)
  assert.deepEqual(roles(template), ['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
  assert.ok(template.filter((item) => item.role).every((item) => item.enabled), 'every edit item enabled')
})

test('contextMenuTemplate: edit items follow what the field allows', () => {
  const template = contextMenuTemplate({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } }, noActions)
  const enabled = Object.fromEntries(template.filter((item) => item.role).map((item) => [item.role, item.enabled]))
  assert.deepEqual(enabled, { undo: false, redo: false, cut: false, copy: false, paste: true, selectAll: true })
})

test('contextMenuTemplate: selected text outside a field gets Copy', () => {
  assert.deepEqual(roles(contextMenuTemplate({ selectionText: 'a reply' }, noActions)), ['copy'])
})

test('contextMenuTemplate: nothing to act on shows no menu', () => {
  assert.deepEqual(contextMenuTemplate({ selectionText: '  ' }, noActions), [])
  assert.deepEqual(contextMenuTemplate({}, noActions), [])
})

test('contextMenuTemplate: a web link gets Copy Link, which copies that link', () => {
  const copied = []
  const template = contextMenuTemplate({ linkURL: 'https://huggingface.co/x' }, { ...noActions, copyLink: (url) => copied.push(url) })
  assert.deepEqual(roles(template), ['Copy Link'])
  template[0].click()
  assert.deepEqual(copied, ['https://huggingface.co/x'])
  assert.deepEqual(contextMenuTemplate({ linkURL: 'javascript:alert(1)' }, noActions), [], 'only web links')
})

test('contextMenuTemplate: a misspelled word offers its suggestions first', () => {
  const replaced = []
  const template = contextMenuTemplate(
    { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'], editFlags: allFlags },
    { ...noActions, replaceMisspelling: (word) => replaced.push(word) },
  )
  assert.deepEqual(roles(template).slice(0, 3), ['the', 'tech', 'separator'])
  template[1].click()
  assert.deepEqual(replaced, ['tech'])
  const none = contextMenuTemplate({ isEditable: true, misspelledWord: 'qzx', dictionarySuggestions: [] }, noActions)
  assert.deepEqual(none[0], { label: 'No spelling suggestions', enabled: false })
})
