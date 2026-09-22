// `UI_ACTIONS` is a CLOSED enum: `uiAction` validates against it and the ingest route drops an
// unrecognised action while still answering 202, so a `track()` call whose action is missing here
// records nothing at all — a defect this file has already shipped twice (Turbo Link fleet
// control, then `manual_compact`). Every click the Jev Playground, the checkpoint picker and the
// Jev load confirmation will track is listed here BEFORE those call sites exist (ADR-333/334).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SCREENS, UI_ACTIONS } from './ui'

const JEV_PLAYGROUND_ACTIONS = [
  'jev_mode_check', 'jev_mode_choose', 'jev_run_check', 'jev_run_choose',
  'jev_add_hypothesis', 'jev_remove_hypothesis', 'jev_add_option', 'jev_remove_option',
  'jev_load_example', 'jev_view_results', 'jev_view_json', 'jev_view_api', 'jev_copy_request',
  'jev_switch_model',
]

const JEV_MODELS_ACTIONS = [
  'download_hf_checkpoint', 'load_hf_checkpoint',
  'confirm_jev_load', 'cancel_jev_load', 'open_jev_playground_toast',
]

test('every Jev Playground action is a recognised UI action', () => {
  const missing = JEV_PLAYGROUND_ACTIONS.filter((a) => !(UI_ACTIONS as readonly string[]).includes(a))

  assert.deepEqual(missing, [])
})

test('every Jev Models-screen action is a recognised UI action', () => {
  const missing = JEV_MODELS_ACTIONS.filter((a) => !(UI_ACTIONS as readonly string[]).includes(a))

  assert.deepEqual(missing, [])
})

test('the 19 new actions are listed exactly once each', () => {
  const counts = [...JEV_PLAYGROUND_ACTIONS, ...JEV_MODELS_ACTIONS].map(
    (a) => (UI_ACTIONS as readonly string[]).filter((x) => x === a).length,
  )

  assert.equal(JEV_PLAYGROUND_ACTIONS.length + JEV_MODELS_ACTIONS.length, 19)
  assert.deepEqual(counts, new Array(19).fill(1))
})

test('the screens these actions are tracked on already exist', () => {
  assert.ok((SCREENS as readonly string[]).includes('workspace'))
  assert.ok((SCREENS as readonly string[]).includes('models'))
})
