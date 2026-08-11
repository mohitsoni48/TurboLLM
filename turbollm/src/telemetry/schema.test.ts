import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVENT_NAMES, MAX_IDENT_LEN, structuralSanityCheck, validateEvent } from './schema'

/** A minimal well-formed journey event — the shape ADR-299 Decision 6 defines. */
function validEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    event: 'app_first_run',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.8.4', os: 'win32/x64' },
    ...over,
  }
}

test('validateEvent: rejects an event name that is not on the allow-list', () => {
  const r = validateEvent(validEvent({ event: 'prompt_captured' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /event/)
})

test('validateEvent: rejects an unknown top-level field, so a prompt cannot ride along', () => {
  const r = validateEvent(validEvent({ prompt: 'what is my ssh key' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /prompt/)
})

test('validateEvent: rejects an unknown field nested inside payload', () => {
  const r = validateEvent(
    validEvent({ event: 'feature_first_use', payload: { feature: 'chat', filePath: 'D:/secrets/id_rsa' } }),
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /filePath/)
})

test('validateEvent: accepts a well-formed feature_first_use', () => {
  const r = validateEvent(validEvent({ event: 'feature_first_use', payload: { feature: 'chat' } }))
  assert.equal(r.ok, true)
})

test('validateEvent: rejects a feature value that is not a known feature', () => {
  const r = validateEvent(validEvent({ event: 'feature_first_use', payload: { feature: 'my-secret-repo-name' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /feature/)
})

test('validateEvent: app_first_run carries no payload at all', () => {
  assert.equal(validateEvent(validEvent({ event: 'app_first_run' })).ok, true)
  const r = validateEvent(validEvent({ event: 'app_first_run', payload: { feature: 'chat' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /no payload/)
})

test('validateEvent: harness_first_seen requires a known harness and protocol (spec 23 §3.5, Phase 5)', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'harness_first_seen', payload: { harness: 'claude_code', protocol: 'anthropic' } })).ok,
    true,
  )
  const missingProtocol = validateEvent(validEvent({ event: 'harness_first_seen', payload: { harness: 'claude_code' } }))
  assert.equal(missingProtocol.ok, false)
  assert.match(missingProtocol.reason, /protocol/)

  const madeUpHarness = validateEvent(validEvent({ event: 'harness_first_seen', payload: { harness: 'some-other-tool', protocol: 'anthropic' } }))
  assert.equal(madeUpHarness.ok, false)
  assert.match(madeUpHarness.reason, /harness/)
})

test('validateEvent: gateway_daily requires harness alongside protocol/volume fields', () => {
  const r = validateEvent(validEvent({
    event: 'gateway_daily',
    payload: { harness: 'opencode', protocol: 'openai', requests: 3, promptTokens: 100, genTokens: 50, distinctModels: 1 },
  }))
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')

  const missingHarness = validateEvent(validEvent({
    event: 'gateway_daily',
    payload: { protocol: 'openai', requests: 3, promptTokens: 100, genTokens: 50, distinctModels: 1 },
  }))
  assert.equal(missingHarness.ok, false)
  assert.match(missingHarness.reason, /harness/)
})

test('validateEvent: ui_action requires a known screen and action (spec 23 §3.8, Phase 6)', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'engines', action: 'install_engine' } })).ok,
    true,
  )
  const madeUpAction = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'engines', action: 'delete_everything' } }))
  assert.equal(madeUpAction.ok, false)
  assert.match(madeUpAction.reason, /action/)

  const madeUpScreen = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'not-a-real-screen', action: 'install_engine' } }))
  assert.equal(madeUpScreen.ok, false)
  assert.match(madeUpScreen.reason, /screen/)
})

test('validateEvent: ui_action accepts the Phase 6b ConversationSidebar batch actions, across their real screens', () => {
  const cases: Array<[string, string]> = [
    ['chat', 'open_conversation'],
    ['chat', 'rename_conversation'],
    ['chat', 'delete_conversation'],
    ['chat', 'move_conversation_to_folder'],
    ['chat', 'new_folder'],
    ['chat', 'rename_folder'],
    ['chat', 'delete_folder'],
    ['chat', 'import_chat'],
    ['chat', 'new_chat'],
    ['code', 'open_code_session'],
    ['code', 'rename_code_session'],
    ['code', 'archive_code_session'],
    ['code', 'delete_code_session'],
    ['code', 'filter_code_sessions'],
    ['code', 'new_code_session'],
    ['code', 'toggle_sidebar_collapsed'],
    ['routines', 'open_routine'],
    ['routines', 'new_routine'],
    ['routines', 'toggle_sidebar_collapsed'],
  ]
  for (const [screen, action] of cases) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen, action } }))
    assert.equal(r.ok, true, r.ok === false ? `${screen}/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6c ModelsScreen batch actions', () => {
  const actions = [
    'switch_models_tab', 'filter_models', 'open_model_folders', 'rescan_models', 'toggle_incompatible_models',
    'select_model_quant', 'eject_model', 'load_model', 'open_model_load_settings', 'pin_model',
    'find_model_quants', 'delete_model', 'set_primary_model_dir', 'remove_model_dir',
    'browse_model_dir', 'add_model_dir',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'models', action } }))
    assert.equal(r.ok, true, r.ok === false ? `models/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6d CustomizeScreen batch actions', () => {
  const actions = [
    'switch_customize_tab', 'close_mcp_panel', 'connect_mcp_server', 'add_local_mcp_server',
    'add_manual_mcp_server', 'update_mcp_server', 'cancel_mcp_edit', 'select_builtin_search',
    'save_builtin_search', 'switch_mcp_tab', 'filter_mcp_category', 'select_mcp_catalog_entry',
    'edit_mcp_server', 'delete_mcp_server', 'open_manual_mcp_form',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'customize', action } }))
    assert.equal(r.ok, true, r.ok === false ? `customize/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6e RoutineEditPage batch actions', () => {
  const actions = [
    'toggle_sidebar_collapsed', 'open_routine', 'back_to_routines', 'create_routine',
    'edit_routine', 'discard_routine_edit', 'review_routine_edit', 'pause_routine',
    'resume_routine', 'run_routine_now', 'delete_routine', 'select_routine_run',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'routines', action } }))
    assert.equal(r.ok, true, r.ok === false ? `routines/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6f MessageBubble batch actions', () => {
  const actions = [
    'toggle_thinking_block', 'toggle_tool_call_detail', 'toggle_source_row', 'toggle_sources_panel',
    'open_edit_message', 'cancel_edit_message', 'save_edited_message', 'save_edited_reply',
    'delete_message', 'regenerate_message', 'switch_message_variant',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'chat', action } }))
    assert.equal(r.ok, true, r.ok === false ? `chat/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6g ChatScreen batch actions', () => {
  const actions = [
    'open_model_settings', 'copy_chat_link', 'copy_chat_debug_info', 'export_chat',
    'dismiss_import_banner', 'use_suggested_prompt', 'scroll_to_latest', 'dismiss_clipboard_modal',
    'select_skill_from_picker', 'remove_attachment', 'attach_file', 'stop_generation', 'send_message',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'chat', action } }))
    assert.equal(r.ok, true, r.ok === false ? `chat/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6h CodeSessionScreen batch actions', () => {
  const actions = [
    'export_code_session', 'open_code_git_dialog', 'back_to_code', 'resume_code_session',
    'send_code_message', 'add_code_context_file', 'revert_code_chat', 'revert_code_chat_and_files',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'code', action } }))
    assert.equal(r.ok, true, r.ok === false ? `code/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6i SettingsScreen batch actions', () => {
  const actions = [
    'switch_settings_tab', 'set_theme', 'save_settings', 'install_comfyui_gate',
    'uninstall_comfyui_gate', 'test_hf_token', 'save_hf_token', 'toggle_telemetry_preview',
    'toggle_submission_log', 'regenerate_machine_id', 'restart_daemon', 'dismiss_restart_overlay',
    'reload_after_restart', 'save_personalization',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'settings', action } }))
    assert.equal(r.ok, true, r.ok === false ? `settings/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6j CodeComposer batch actions', () => {
  const actions = [
    'select_code_slash_command', 'select_code_file_mention', 'select_code_repo', 'browse_code_repo',
    'select_code_base_branch', 'remove_code_context_file', 'remove_code_image', 'set_code_mode',
    'open_code_context_browser', 'stop_code_generation',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'code', action } }))
    assert.equal(r.ok, true, r.ok === false ? `code/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6k ModelDetailDialog batch actions', () => {
  const actions = [
    'view_model_hf_repo', 'toggle_model_advanced_settings', 'load_model_with_settings',
    'save_model_settings', 'reset_model_settings', 'dismiss_autotune_result', 'save_autotune_result',
    'cancel_autotune', 'start_autotune', 'reset_model_setting_field', 'set_model_setting_option',
    'remove_model_setting_chip',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'models', action } }))
    assert.equal(r.ok, true, r.ok === false ? `models/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6l BuildGuideDialog batch actions', () => {
  const actions = [
    'remove_build_search_dir', 'add_build_search_dir', 'recheck_build_prereqs',
    'copy_build_commands', 'close_build_guide', 'open_manual_build_handoff', 'start_engine_build',
    'dismiss_build_success', 'cancel_engine_build', 'download_cuda_toolkit',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'engines', action } }))
    assert.equal(r.ok, true, r.ok === false ? `engines/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6m AgentEditPage batch actions', () => {
  const actions = [
    'toggle_agent_tool_group', 'back_to_agents', 'reset_agent_to_default', 'save_agent',
    'switch_agent_form_tab', 'delete_agent', 'cancel_delete_agent',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'agents', action } }))
    assert.equal(r.ok, true, r.ok === false ? `agents/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6n CodeHomeScreen batch actions', () => {
  const actions = ['switch_code_stats_range', 'use_starter_task']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'code', action } }))
    assert.equal(r.ok, true, r.ok === false ? `code/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6o AddEngineDialog batch actions', () => {
  const actions = [
    'browse_new_engine_folder', 'browse_new_engine_binary', 'cancel_add_engine',
    'back_to_add_engine_choose', 'submit_new_engine', 'select_new_engine_path',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'engines', action } }))
    assert.equal(r.ok, true, r.ok === false ? `engines/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6p SkillEditPage batch actions', () => {
  const actions = ['back_to_skills', 'save_skill', 'delete_skill', 'cancel_delete_skill']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'skills', action } }))
    assert.equal(r.ok, true, r.ok === false ? `skills/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6q HfRepoDialog batch actions', () => {
  const actions = [
    'load_hf_quant', 'download_hf_quant', 'select_hf_quant', 'download_hf_model',
    'search_hf_from_error', 'retry_hf_repo_load',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'models', action } }))
    assert.equal(r.ok, true, r.ok === false ? `models/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6s FsBrowser batch actions', () => {
  const actions = [
    'navigate_fs_up', 'navigate_fs_to_path', 'refresh_fs_browser', 'open_fs_folder',
    'cancel_fs_browser',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'engines', action } }))
    assert.equal(r.ok, true, r.ok === false ? `engines/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6t SkillsLibrary batch actions', () => {
  const actions = ['open_skill', 'upload_skill_file', 'create_skill', 'learn_skill_from_folder']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'skills', action } }))
    assert.equal(r.ok, true, r.ok === false ? `skills/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6u CodeTranscript batch actions', () => {
  const actions = ['toggle_code_tool_detail', 'send_queued_code_message']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'code', action } }))
    assert.equal(r.ok, true, r.ok === false ? `code/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6v RoutineConfirmCard batch actions', () => {
  const actions = [
    'cancel_routine_confirm_edit', 'save_routine_confirm_edit', 'edit_routine_confirm',
    'cancel_routine_confirm', 'confirm_routine',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'routines', action } }))
    assert.equal(r.ok, true, r.ok === false ? `routines/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6x DiscoverTab batch actions', () => {
  const actions = ['open_import_url_dialog', 'select_discover_result']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'models', action } }))
    assert.equal(r.ok, true, r.ok === false ? `models/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6y ToolApprovalBar batch actions', () => {
  const actions = ['deny_tool_call', 'allow_tool_call', 'allow_tool_call_for_chat', 'always_allow_tool_call']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'chat', action } }))
    assert.equal(r.ok, true, r.ok === false ? `chat/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6z AgentsLibrary batch actions', () => {
  const actions = ['open_agent_card', 'set_default_agent', 'new_agent']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'agents', action } }))
    assert.equal(r.ok, true, r.ok === false ? `agents/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6aa DeveloperScreen batch actions', () => {
  const actions = ['revoke_api_key', 'create_api_key', 'select_connect_cli']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'developer', action } }))
    assert.equal(r.ok, true, r.ok === false ? `developer/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6bb RoutineFormFields batch actions', () => {
  const actions = ['set_routine_flavor', 'browse_routine_workspace', 'toggle_routine_weekday', 'select_routine_workspace']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'routines', action } }))
    assert.equal(r.ok, true, r.ok === false ? `routines/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6dd CodeContextSection batch actions', () => {
  const actions = ['add_context_candidate', 'remove_context_candidate', 'save_context_candidates']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'settings', action } }))
    assert.equal(r.ok, true, r.ok === false ? `settings/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6gg DownloadsPanel batch actions', () => {
  const actions = ['resume_download', 'cancel_download', 'remove_download']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'models', action } }))
    assert.equal(r.ok, true, r.ok === false ? `models/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6hh ConversationSettingsDialog batch actions', () => {
  const actions = ['reset_thread_sampling', 'toggle_preserve_thinking', 'save_thread_settings']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'chat', action } }))
    assert.equal(r.ok, true, r.ok === false ? `chat/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6ii ArtifactCard batch actions', () => {
  const actions = ['toggle_artifact_interactive', 'toggle_artifact_fit', 'download_artifact']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'chat', action } }))
    assert.equal(r.ok, true, r.ok === false ? `chat/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6jj batch actions (4 small files)', () => {
  const byScreen: Record<string, string[]> = {
    settings: ['toggle_auto_allow_tools', 'set_tool_policy'],
    models: ['close_import_url_dialog', 'import_model_url'],
    engines: ['restart_engine', 'cancel_custom_build_dialog', 'continue_custom_build_dialog'],
  }
  for (const [screen, actions] of Object.entries(byScreen)) {
    for (const action of actions) {
      const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen, action } }))
      assert.equal(r.ok, true, r.ok === false ? `${screen}/${action}: ${r.reason}` : '')
    }
  }
})

test('validateEvent: ui_action accepts the Phase 6kk batch actions (12 small files)', () => {
  const byScreen: Record<string, string[]> = {
    routines: ['approve_routine_tool_call', 'deny_routine_tool_call'],
    engines: [
      'dismiss_engine_provision_error', 'cancel_engine_provision',
      'open_engines_from_error_banner', 'dismiss_engine_error_banner',
      'toggle_engine_log_autoscroll', 'open_engines_from_nav_chip',
    ],
    tokens: ['show_more_token_models', 'switch_token_tab', 'switch_token_range'],
    settings: ['delete_memory_fact', 'set_default_code_agent'],
    code: ['open_context_usage_detail', 'toggle_code_resources_header'],
    developer: ['submit_auth_key'],
  }
  for (const [screen, actions] of Object.entries(byScreen)) {
    for (const action of actions) {
      const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen, action } }))
      assert.equal(r.ok, true, r.ok === false ? `${screen}/${action}: ${r.reason}` : '')
    }
  }
})

test('validateEvent: ui_action accepts the Phase 6ll batch actions (copy-button.tsx, InlineError) -- closes the Phase 6 backlog', () => {
  const screens = ['engines', 'models', 'developer', 'settings', 'code', 'chat']
  for (const screen of screens) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen, action: 'copy_button_click' } }))
    assert.equal(r.ok, true, r.ok === false ? `${screen}/copy_button_click: ${r.reason}` : '')
  }
  const retryScreens = ['tokens', 'models', 'routines', 'engines']
  for (const screen of retryScreens) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen, action: 'retry_failed_load' } }))
    assert.equal(r.ok, true, r.ok === false ? `${screen}/retry_failed_load: ${r.reason}` : '')
  }
})

test('validateEvent: ui_action accepts the Phase 6ee CodeGitDialog batch actions', () => {
  const actions = ['commit_code_git', 'push_code_git', 'close_code_git_dialog']
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'code', action } }))
    assert.equal(r.ok, true, r.ok === false ? `code/${action}: ${r.reason}` : '')
  }
})

test('validateEvent: ui_daily requires screen plus both volume counters', () => {
  const r = validateEvent(validEvent({ event: 'ui_daily', payload: { screen: 'engines', actions: 5, distinctActions: 3 } }))
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')

  const missingCounts = validateEvent(validEvent({ event: 'ui_daily', payload: { screen: 'engines' } }))
  assert.equal(missingCounts.ok, false)
})

test('validateEvent: onboarding_step no longer exists (spec 23 §4, Phase 7) — the whole event is gone, not just its steps', () => {
  const r = validateEvent(validEvent({ event: 'onboarding_step', payload: { step: 'model_download', outcome: 'ok' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /event/)
})

test('validateEvent: model_downloaded requires a known outcome, reporting ok/fail/cancelled (promoted out of onboarding_step)', () => {
  for (const outcome of ['ok', 'fail', 'cancelled']) {
    assert.equal(
      validateEvent(validEvent({ event: 'model_downloaded', payload: { outcome } })).ok,
      true,
      `model_downloaded should accept outcome '${outcome}'`,
    )
  }
  const r = validateEvent(validEvent({ event: 'model_downloaded', payload: {} }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /outcome/)
})

test('validateEvent: model_first_load takes an optional enum failReason', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'model_first_load', payload: { outcome: 'fail', failReason: 'oom' } })).ok,
    true,
  )
  assert.equal(validateEvent(validEvent({ event: 'model_first_load', payload: { outcome: 'ok' } })).ok, true)
})

test('validateEvent: engine_installed takes an optional enum failReason (promoted out of onboarding_step: engine_install)', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'engine_installed', payload: { outcome: 'fail', failReason: 'network' } })).ok,
    true,
  )
  assert.equal(
    validateEvent(validEvent({ event: 'engine_installed', payload: { outcome: 'ok' } })).ok,
    true,
    'failReason is optional — an ok outcome need not carry one',
  )
  const r = validateEvent(validEvent({ event: 'engine_installed', payload: { outcome: 'fail', failReason: 'oom' } }))
  assert.equal(r.ok, false, "'oom' is a model-load reason, not a provisioning one — must not validate here")
})

test('validateEvent: error requires a known fingerprint', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'error', payload: { fingerprint: 'engine_crash' } })).ok,
    true,
  )
  const r = validateEvent(validEvent({ event: 'error', payload: { fingerprint: 'stack trace: at foo.ts:42' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /fingerprint/)
})

test('validateEvent: feature_used_daily requires a known feature and a bucketed count, never a raw number', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'feature_used_daily', payload: { feature: 'chat', countBucket: '6-20' } })).ok,
    true,
  )
  const r = validateEvent(validEvent({ event: 'feature_used_daily', payload: { feature: 'chat', countBucket: 17 } }))
  assert.equal(r.ok, false, 'a raw number must never validate as a countBucket')
})

test('validateEvent: model_first_load rejects a free-text failure message', () => {
  const r = validateEvent(
    validEvent({
      event: 'model_first_load',
      payload: { outcome: 'fail', failReason: 'CUDA error loading D:/models/private.gguf' },
    }),
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /failReason/)
})

test('validateEvent: feature_used_daily reports a bucket, never a raw count', () => {
  assert.equal(
    validateEvent(validEvent({ event: 'feature_used_daily', payload: { feature: 'code', countBucket: '6-20' } })).ok,
    true,
  )
  const r = validateEvent(validEvent({ event: 'feature_used_daily', payload: { feature: 'code', countBucket: 17 } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /countBucket/)
})

/** The real shape `bench.ts` already queues today (bench.ts:1144). */
function benchEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    event: 'bench_result',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.8.4', os: 'win32/x64' },
    hw: {
      cpu: 'AMD Ryzen 9 7950X 16-Core Processor',
      ramMb: 65536,
      gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16384 }],
    },
    payload: {
      source: 'autotune',
      model: { name: 'Qwen3.6-35B-A22B', quant: 'Q4_K_M', sizeBytes: 21_000_000_000, arch: 'qwen3moe', moe: true },
      engine: { version: 'b1234' },
      params: { ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvTypeK: 'q8_0', flashAttn: 'auto' },
      result: { tps: 48.2, ttftMs: 310, vramMb: 15800, outcome: 'ok' },
    },
    ...over,
  }
}

test('validateEvent: bench_result requires a real source — autotune|chat|gateway|code', () => {
  const r = validateEvent(benchEvent({ payload: { ...(benchEvent().payload as object), source: undefined } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /source/)
})

test('validateEvent: bench_result accepts every real source value, from every real trigger', () => {
  for (const source of ['autotune', 'chat', 'gateway', 'code']) {
    const e = benchEvent()
    ;(e.payload as Record<string, unknown>).source = source
    const r = validateEvent(e)
    assert.equal(r.ok, true, r.ok === false ? `${source}: ${r.reason}` : '')
  }
})

test('validateEvent: bench_result rejects a source outside the closed enum', () => {
  const e = benchEvent()
  ;(e.payload as Record<string, unknown>).source = 'made_up_source'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /source/)
})

test('validateEvent: accepts the bench_result shape bench.ts already produces', () => {
  const r = validateEvent(benchEvent())
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('validateEvent: a model name long enough to hide a prompt is rejected', () => {
  const e = benchEvent()
  const payload = e.payload as { model: Record<string, unknown> }
  payload.model.name = 'x'.repeat(200)
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /model\.name/)
})

test('validateEvent: a model name containing a filesystem path is rejected', () => {
  const e = benchEvent()
  const payload = e.payload as { model: Record<string, unknown> }
  payload.model.name = 'D:\\models\\private\\secret.gguf'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /model\.name/)
})

test('validateEvent: a unix path smuggled through the cpu identifier is rejected', () => {
  const e = benchEvent()
  const hw = e.hw as Record<string, unknown>
  hw.cpu = '/home/mo/.ssh/id_rsa'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /hw\.cpu/)
})

test('validateEvent: an unknown field inside the bench payload is rejected', () => {
  const e = benchEvent()
  const payload = e.payload as Record<string, unknown>
  payload.systemPrompt = 'you are a helpful assistant'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /systemPrompt/)
})

test('validateEvent: an unmeasured vramMb (null) is accepted — BenchResult.vramMb is number|null', () => {
  const e = benchEvent()
  const payload = e.payload as { result: Record<string, unknown> }
  payload.result.vramMb = null
  const r = validateEvent(e)
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('validateEvent: a non-numeric t/s is rejected', () => {
  const e = benchEvent()
  const payload = e.payload as { result: Record<string, unknown> }
  payload.result.tps = 'fast'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /tps/)
})

test('validateEvent: app.version is a capped identifier, not a free string', () => {
  const r = validateEvent(validEvent({ app: { version: 'x'.repeat(200), os: 'win32/x64' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /app\.version/)
})

test('validateEvent: a prototype-chain property cannot smuggle a free-form string through payload', () => {
  // Found in Opus pre-release review: checkFields used `key in spec`, which
  // walks Object.prototype — so 'toString'/'constructor'/'valueOf' passed the
  // "known field" check and were then never validated, since the second loop
  // only iterates the spec's OWN entries. Reproducing the exact review PoC.
  const r = validateEvent(
    validEvent({
      event: 'feature_first_use',
      payload: { feature: 'chat', toString: 'C:\\Users\\Owner\\secret\\prompt.txt ' + 'x'.repeat(400) },
    }),
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /toString/)
})

test('validateEvent: a prototype-chain property cannot smuggle a free-form string through app', () => {
  const r = validateEvent(validEvent({ app: { version: '1.9.2', os: 'win32/x64', constructor: 'arbitrary' } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /constructor/)
})

test('validateEvent: a prototype-chain property cannot smuggle a free-form string through the bench payload', () => {
  const e = benchEvent()
  const p = e.payload as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately
  // bypassing the compiler's own strict typing of the inherited method, since
  // the whole point is proving an untyped attacker payload can do this.
  ;(p as any).hasOwnProperty = 'smuggled'
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /hasOwnProperty/)
})

test('validateEvent: app.os accepts the REAL shape sysinfo.ts produces, not a fabricated fixture', () => {
  // Found live: getSysInfo().os is `${process.platform}/${process.arch}` (sysinfo.ts),
  // e.g. "win32/x64" or "darwin/arm64" — every unit test fixture in this file (including
  // ones above) had hand-written 'win32' with no slash, so this was never exercised
  // against the real value. Every real Emitter.emit() call embeds this string
  // unconditionally, so before this test the real client could never successfully
  // queue a single journey event on any platform — confirmed by running the actual
  // daemon end-to-end and finding every event silently rejected at this exact field.
  for (const os of ['win32/x64', 'darwin/arm64', 'linux/x64']) {
    const r = validateEvent(validEvent({ app: { version: '1.9.0', os } }))
    assert.equal(r.ok, true, r.ok === false ? `${os}: ${r.reason}` : '')
  }
})

test('validateEvent: app.os still rejects a real path, despite now allowing a slash', () => {
  // The platform/arch shape is exactly ONE slash between two short alnum tokens —
  // narrow enough that a real filesystem path (multiple segments, dots, drive
  // letters, backslashes) cannot pass through the same allowance.
  for (const os of ['D:\\models\\private\\secret.gguf', '/home/mo/.ssh/id_rsa', 'win32/x64/extra', '../../etc/passwd']) {
    const r = validateEvent(validEvent({ app: { version: '1.9.0', os } }))
    assert.equal(r.ok, false, `expected ${os} to be rejected`)
  }
})

test('validateEvent: schema must exactly equal the current wire version', () => {
  // Found in Opus pre-release review: 'schema' was in ENVELOPE_KEYS (so it rode
  // through the top-level allow-list) but never actually checked — any value,
  // any size, reached the Worker and D1/PostHog verbatim.
  assert.equal(validateEvent(validEvent({ schema: 2 })).ok, false)
  assert.equal(validateEvent(validEvent({ schema: 'z'.repeat(600) })).ok, false)
  assert.equal(validateEvent(validEvent({ schema: 1 })).ok, true)
})

test('validateEvent: ts must be a bounded ISO-8601 timestamp, not an arbitrary object or string', () => {
  // Same finding: 'ts' was allow-listed but never validated at all. Reproducing
  // the review's exact PoC — a free-form path leaked through a nested field.
  const withObjectTs = validEvent()
  withObjectTs.ts = { leak: 'C:/Users/Owner/Documents/prompt.txt', big: 'y'.repeat(300) }
  assert.equal(validateEvent(withObjectTs).ok, false)

  assert.equal(validateEvent(validEvent({ ts: 'not a timestamp' })).ok, false)
  assert.equal(validateEvent(validEvent({ ts: '2026-07-29T12:00:00.000Z' })).ok, true)
})

test('validateEvent: consent_choice with an oversized schema value is still rejected', () => {
  // The finding's own example: the schema field was reachable even on
  // consent_choice, the one event required to carry nothing attributable.
  const r = validateEvent({ schema: 'q'.repeat(200), event: 'consent_choice', level: 'off' })
  assert.equal(r.ok, false)
})

test('validateEvent: a machineId that is not a plain uuid-shaped id is rejected', () => {
  const r = validateEvent(validEvent({ machineId: '../../etc/passwd' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /machineId/)
})

test('validateEvent: the Off consent ping is accepted with no machineId, app, or ts', () => {
  const r = validateEvent({ schema: 1, event: 'consent_choice', level: 'off' })
  assert.equal(r.ok, true)
})

test('validateEvent: a consent_choice may never carry a machineId, so it stays unattributable', () => {
  const r = validateEvent({
    schema: 1,
    event: 'consent_choice',
    level: 'off',
    machineId: '00000000-0000-0000-0000-000000000000',
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /machineId/)
})

test('validateEvent: consent_choice requires a known level', () => {
  const r = validateEvent({ schema: 1, event: 'consent_choice', level: 'maybe' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /level/)
})

test('validateEvent: level is rejected on any event other than consent_choice', () => {
  const r = validateEvent(validEvent({ event: 'app_first_run', level: 'anon' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /level/)
})

test('validateEvent: a normal event without a machineId is rejected', () => {
  const e = validEvent()
  delete e.machineId
  const r = validateEvent(e)
  assert.equal(r.ok, false)
  assert.match(r.reason, /machineId/)
})

test('validateEvent: error carries an enum fingerprint, never log text', () => {
  assert.equal(validateEvent(validEvent({ event: 'error', payload: { fingerprint: 'cuda_oom' } })).ok, true)
  const r = validateEvent(
    validEvent({ event: 'error', payload: { fingerprint: 'Traceback: /home/mo/.ssh/id_rsa not found' } }),
  )
  assert.equal(r.ok, false)
  assert.match(r.reason, /fingerprint/)
})

// structuralSanityCheck (ADR-331/333) — the coarse, permanent gate the Worker
// uses to decide "quarantine this" vs "destroy this" when validateEvent
// itself rejects an event. Every one of these cases must keep passing no
// matter how EVENT_NAMES/PAYLOAD_SPECS evolve, since that is the entire point
// of the function: it must never need to change alongside the schema.

test('structuralSanityCheck: rejects a non-object', () => {
  assert.equal(structuralSanityCheck('not an event').ok, false)
  assert.equal(structuralSanityCheck(null).ok, false)
  assert.equal(structuralSanityCheck([1, 2, 3]).ok, false)
})

test('structuralSanityCheck: accepts every current real event name, unchanged forever', () => {
  for (const event of EVENT_NAMES) {
    const r = structuralSanityCheck({ event })
    assert.equal(r.ok, true, r.ok === false ? `${event}: ${r.reason}` : '')
  }
})

test('structuralSanityCheck: accepts an event name this schema has never heard of — the whole point', () => {
  // The exact shape of the bug this exists to fix: a client on a newer schema
  // sends an event name an older deployed Worker does not recognise yet.
  const r = structuralSanityCheck({ event: 'model_load', schema: 2, payload: { quant: 'Q4_K_M' } })
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('structuralSanityCheck: rejects an event name shaped to abuse the check itself', () => {
  assert.equal(structuralSanityCheck({ event: 'x'.repeat(200) }).ok, false)
  assert.equal(structuralSanityCheck({ event: 'Not-Lowercase' }).ok, false)
  assert.equal(structuralSanityCheck({ event: '' }).ok, false)
  assert.equal(structuralSanityCheck({ event: 123 }).ok, false)
})

test('structuralSanityCheck: consent_choice may never carry anything attributable — hard invariant, not quarantine-eligible', () => {
  assert.equal(structuralSanityCheck({ event: 'consent_choice', level: 'off' }).ok, true)
  for (const banned of ['machineId', 'app', 'hw', 'ts', 'payload']) {
    const r = structuralSanityCheck({ event: 'consent_choice', level: 'off', [banned]: 'x' })
    assert.equal(r.ok, false, `consent_choice carrying ${banned} must never pass, even for quarantine`)
  }
})

test('structuralSanityCheck: a future field with a normal-length value passes, so real drift is never blocked', () => {
  const r = structuralSanityCheck({
    event: 'model_load',
    payload: { quant: 'Q4_K_M', kvTypeK: 'q8_0', aBrandNewFieldThisSchemaDoesNotKnowAbout: 'gpu_offload_partial' },
  })
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('structuralSanityCheck: rejects a string long enough to be a smuggled prompt or path, even under an unrecognized field name', () => {
  const r = structuralSanityCheck({
    event: 'app_first_run',
    prompt: 'x'.repeat(MAX_IDENT_LEN + 1),
  })
  assert.equal(r.ok, false)
})

test('structuralSanityCheck: accepts a string right at the existing bench_result identifier cap', () => {
  const r = structuralSanityCheck({ event: 'bench_result', payload: { model: { name: 'x'.repeat(MAX_IDENT_LEN) } } })
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('structuralSanityCheck: the oversized-string scan reaches nested objects and arrays alike', () => {
  const nested = structuralSanityCheck({
    event: 'bench_result',
    hw: { gpus: [{ name: 'fine' }, { name: 'x'.repeat(MAX_IDENT_LEN + 1) }] },
  })
  assert.equal(nested.ok, false)
})

test('structuralSanityCheck: a pathologically deep small payload is treated as unsafe rather than recursing unbounded', () => {
  let deep: Record<string, unknown> = { leaf: 'x' }
  for (let i = 0; i < 20; i++) deep = { nested: deep }
  const r = structuralSanityCheck({ event: 'app_first_run', payload: deep })
  assert.equal(r.ok, false)
})

// Task 9: the onboarding screen now exists (spec 25, ADR-338)
test('validateEvent: ui_action accepts the Phase 7 Onboarding screen actions', () => {
  const actions = [
    'skip_onboarding_welcome', 'skip_onboarding_profile', 'skip_onboarding_model',
    'skip_onboarding_personalize', 'skip_onboarding_profile_extra', 'skip_onboarding_load',
    'skip_onboarding_payoff', 'skip_onboarding_tune_offer',
    'choose_profile', 'start_model_download', 'use_existing_models',
    'open_discover_handoff', 'pick_different_model', 'accept_autotune',
    'decline_autotune', 'finish_onboarding', 'resume_onboarding',
    'dismiss_finish_banner', 'take_recovery_action',
  ]
  for (const action of actions) {
    const r = validateEvent(validEvent({ event: 'ui_action', payload: { screen: 'onboarding', action } }))
    assert.equal(r.ok, true, r.ok === false ? `onboarding/${action}: ${r.reason}` : '')
  }
})
