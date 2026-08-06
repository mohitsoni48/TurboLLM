/** UI click-stream (spec 23 §3.8, ADR-333, "every clickable element"). One generic event so
 *  full coverage never needs a new schema entry per button — adding a button is one enum
 *  value (`UI_ACTIONS`) plus one `track(screen, action)` call site.
 *
 *  `SCREENS` is spec 23's list, corrected against the actual frontend (`web/src/screens/`):
 *  `onboarding` was dropped — no such screen exists in this codebase today (onboarding_step,
 *  the EVENT, is a separate thing being retired in Phase 7; there is no onboarding UI to
 *  attribute a click to). Everything else matches a real top-level screen file.
 *
 *  `UI_ACTIONS` is intentionally NOT the full ~361-handler set yet — spec 23 §3.8 itself
 *  recommends landing this schema first, then instrumenting the 361 call sites in per-screen
 *  batches, each independently reviewable, rather than one unreviewable mass diff. Only
 *  actions with a real `track()` call site belong in this enum; see `docs/TODO.md` for the
 *  ordered list of screens still to instrument. Adding a screen's actions is a pure enum
 *  addition (additive, `since` bump not required — same event, richer enum) plus a Worker
 *  redeploy, exactly like every other enum that has grown across these phases (`HARNESSES`).
 *
 *  No `surface` field yet (spec's optional disambiguator) — nothing instrumented so far needs
 *  it (every action name is already unambiguous on its own); added when a real case does,
 *  rather than shipping enum values with no referent. */

import { defineEvent, f } from '../core/define'

export const SCREENS = [
  'chat', 'models', 'engines', 'code', 'customize', 'settings', 'tokens',
  'workspace', 'developer', 'routines', 'agents', 'skills',
] as const

/** Batch 1 (Phase 6a): `EnginesScreen.tsx` + its `EngineCard`/`CustomEngineCard`
 *  sub-components — 18 handler sites, 11 distinct actions (several handlers share an
 *  action across surfaces, e.g. the inline "Update" button and the overflow menu's
 *  "Update now" both fire `update_engine`).
 *
 *  Batch 2 (Phase 6b): `ConversationSidebar.tsx` — 33 raw `onClick`/`onSelect` matches,
 *  of which 6 are `e.stopPropagation()`-only guards (no user-observable action distinct
 *  from the real handler they protect) and 4 are `onSelect={onSelect}`-shaped prop
 *  forwarding to a child component, not a DOM/menu-item handler at all — neither kind
 *  gets its own action. The remaining sites map to 18 distinct actions; several deletes
 *  are tracked once inside the shared `doDelete*` function rather than at each UI entry
 *  point, since the same delete can be reached both through a confirmation dialog AND
 *  (when the user has turned confirmation off in Settings) directly — one call site
 *  correctly covers both paths instead of missing the un-confirmed one.
 *
 *  Batch 3 (Phase 6c): `ModelsScreen.tsx` — 21 raw matches, 1 plumbing (`FilterChip`'s own
 *  generic `onClick={onClick}`, which just relays whichever specific filter the call site
 *  already tracks — tracking inside the shared component would double-count every filter
 *  click). Model deletion always goes through a confirm dialog here (no "skip confirm"
 *  setting like chat's), so it is tracked once at the dialog's confirm action, not at the
 *  menu item that merely opens it.
 *
 *  Batch 4 (Phase 6d): `CustomizeScreen.tsx` — 21 raw matches, 15 distinct actions. Same
 *  add-vs-update fold as `handleSubmit` sharing one function for both the manual-add form
 *  and the edit form: tracked once inside `handleSubmit` with the action resolved from its
 *  own `isEdit` branch, rather than at each button, so the two real outcomes (create vs.
 *  update) stay distinguishable regardless of which button triggered them. `window.confirm`
 *  (not the app's own AlertDialog) still gates the one destructive action here
 *  (`delete_mcp_server`) — tracked after the confirm check passes, same "track the real
 *  outcome, not the request" rule as every prior batch's confirm dialogs.
 *
 *  Batch 5 (Phase 6e): `screens/routines/RoutineEditPage.tsx` — 19 raw matches, 10 new
 *  distinct actions (plus 2 reused: `toggle_sidebar_collapsed`/`open_routine`, already in the
 *  enum from Batches 1-2 and semantically the same action here even though this file's mobile
 *  hamburger/backdrop and "Open routine" CTA are physically different controls). Two skips:
 *  the sidebar's `onSelect`/`onNew` props relay straight into `ConversationSidebar`, whose own
 *  row/button handlers already call `track()` internally before invoking them (Batch 2) — a
 *  second call here would double-count; and the Delete icon button only opens the confirm
 *  dialog (`setDeleteConfirmOpen(true)`), so per the "track the outcome, not the request" rule
 *  `delete_routine` is tracked at the `AlertDialogAction` that actually fires the DELETE, not
 *  here. All four `goBack` call sites (create-form's chevron and Cancel, the error state's
 *  "Back to routines", the detail view's chevron) fold into one `back_to_routines` tracked
 *  once inside `goBack` itself, mirroring Batch 1's `update_engine`. The two run-selection
 *  buttons (a stalled run needing approval vs. a normal run row) fold into one
 *  `select_routine_run`, same reasoning.
 *
 *  Batch 6 (Phase 6f): `screens/chat/MessageBubble.tsx` — 19 raw matches, 11 new distinct
 *  actions. One skip is the exact `FilterChip`/`McpCard` shape again: `ActionBtn`'s own
 *  generic `onClick={onClick}` relay — the real action is tracked at each of its 5 call sites
 *  (Edit/Delete/Regenerate on both message roles), not inside the shared component. The other
 *  skip is a genuine `e.stopPropagation()` guard on a source link. Several folds across the
 *  user/assistant message halves, which duplicate the same controls for both roles: opening
 *  edit mode (`open_edit_message`), cancelling it (`cancel_edit_message`) and deleting
 *  (`delete_message`) are the same action regardless of role, so one name covers both. Saving
 *  an edit is NOT folded the same way — a user-message save resends and triggers a new
 *  generation, an assistant-message save only fixes the reply's text in place (this file's own
 *  GitHub #52 comment), a real behavioral difference worth keeping visible as
 *  `save_edited_message` vs. `save_edited_reply`. `regenerate_message` folds the error-state
 *  fallback's inline "Regenerate" link with the normal hover action — both call the identical
 *  `onRegenerate` prop.
 *
 *  Batch 7 (Phase 6g): `screens/ChatScreen.tsx` — 19 raw matches, 13 new distinct actions (plus
 *  `toggle_sidebar_collapsed` reused for this file's own mobile hamburger/backdrop, same as
 *  Batch 5). Two skips: the sidebar's `onSelect` prop relays into `ConversationSidebar`, which
 *  already tracks internally (Batch 2); and the clipboard-fallback modal's inner
 *  `e.stopPropagation()` guard. Two folds: the import-mismatch and import-error banners' close
 *  buttons share `dismiss_import_banner` (same dismiss affordance, different message); the
 *  clipboard-modal's backdrop click and its explicit × button share `dismiss_clipboard_modal`
 *  for the same reason. `send_message`/`stop_generation` are tracked despite being this
 *  screen's highest-frequency clicks — the founder's "every clickable element" instruction
 *  draws no volume exception, and `ui_daily`'s per-screen rollup exists precisely to keep
 *  aggregate volume bounded regardless of how often any one action fires (same reasoning
 *  `chat_daily` already applies to actual message counts).
 *
 *  Batch 8 (Phase 6h): `screens/code/CodeSessionScreen.tsx` — 16 raw matches, 8 new distinct
 *  actions (plus 3 reused: `toggle_sidebar_collapsed`, `rename_code_session` from Batch 2, and
 *  `scroll_to_latest` from Batch 7 — Code mode's "Jump to latest" is the identical action on a
 *  different screen). Two skips: the same `ConversationSidebar` `onSelect` relay as every other
 *  batch that embeds it, and `CodeComposer`'s `onValueChange={setInput}` — a controlled-input
 *  keystroke sync, not a discrete click, the same category ChatScreen's textarea `onChange`
 *  was never grepped/tracked either. Two call sites are NOT skipped despite also being props
 *  passed to a child component (`CodeComposer`'s `onSubmit`, `FsBrowser`'s `onSelect`):
 *  ModelsScreen's Batch 3 precedent (`add_model_dir`, tracked at the call site supplying
 *  `FsBrowser` its value, not inside the shared dialog) tracks at the site that performs the
 *  real mutation, and both of these do — `onSubmit` calls `send(kind)`, `onSelect` calls
 *  `setContextFiles`. **Note for whoever instruments `CodeComposer.tsx` below**: its own Send
 *  button almost certainly calls this same `onSubmit` prop — that click must NOT get a second
 *  `track()` call, `send_code_message` already fires here. The revert dialog's two real outcomes
 *  (`runRevert(id, false)` vs `runRevert(id, true)`) split into `revert_code_chat` vs
 *  `revert_code_chat_and_files` — a real behavioral difference (whether file edits are also
 *  discarded), same reasoning as Batch 6's edit-save split; the file-edits-free single-button
 *  case calls the same `runRevert(id, false)` and folds into `revert_code_chat`.
 *
 *  Batch 9 (Phase 6i): `screens/SettingsScreen.tsx` — 16 raw matches, 14 new distinct actions,
 *  no skips. Three ComfyUI-gate buttons (the update-available banner's "Update node", the
 *  utility row's "Reinstall / update", and the initial "Install gate") all call the exact same
 *  local `doInstall(path)` with only the path source differing — tracked once inside
 *  `doInstall` itself as `install_comfyui_gate`, same "shared action across entry points"
 *  pattern as Batch 1's `update_engine`. `save_hf_token` covers both the "Save token" and
 *  "Clear token" labels of the same button (`handleSaveToken` branches purely on whether the
 *  field is empty, same mutation either way) — unlike Batch 6's edit-save split, there is no
 *  real behavioral fork here worth preserving in the data.
 *
 *  Batch 10 (Phase 6j): `screens/code/CodeComposer.tsx` — 14 raw matches, 10 new distinct
 *  actions, 4 skips. `CodeComposer` is ONE component rendered by both `CodeHomeScreen.tsx`
 *  (pre-session, `onSubmit={() => void send()}`, not yet instrumented) and
 *  `CodeSessionScreen.tsx` (mid-session, Batch 8 already tracks `send_code_message` at its own
 *  `onSubmit={...}` assignment) — its internal Send/steer/follow-up buttons all call
 *  `handleSubmit`, which calls the SAME `onSubmit` prop. Tracking here would double-count for
 *  `CodeSessionScreen` while `CodeHomeScreen` stays silently uncovered either way, so — same
 *  "track at the specific call site that supplies the real value" rule as `ModelsScreen`'s
 *  `FsBrowser` usage — all three submit buttons are skipped here. **Note for whoever
 *  instruments `CodeHomeScreen.tsx`**: track `send_code_message` at its own
 *  `onSubmit={() => void send()}` line, mirroring `CodeSessionScreen.tsx`, NOT inside this
 *  file. The Stop button (`onStop`) has no such conflict — neither caller's own `onStop={...}`
 *  assignment matches the grep selector (`onStop=` isn't one of its five patterns), so this
 *  file's button is the only real click site for it; tracked here as `stop_code_generation`.
 *  The fourth skip is the textarea's own `onSelect` — caret-position tracking for the
 *  `@`-mention popover, not a discrete action, same category as Batch 8's `onValueChange` skip.
 *  `select_code_repo`/`browse_code_repo`/`select_code_base_branch`/`set_code_mode` are tracked
 *  here (not deferred) because their real DOM click sites live only in this shared file — both
 *  callers merely supply the `repo`/`onModeChange` props consumed here, they render no
 *  competing UI of their own for these. `open_code_context_browser` is a previously-invisible
 *  action: `onAddContext=` never matched the grep selector in either caller's own file, so this
 *  is the first time the button that OPENS the context-file browser gets tracked at all
 *  (distinct from `add_code_context_file`, Batch 8's action for actually SELECTING a file once
 *  the browser is open).
 *
 *  Batch 11 (Phase 6k): `screens/models/ModelDetailDialog.tsx` — 13 raw matches, 12 new
 *  distinct actions, no skips. Screen tagged `models` throughout even though this dialog opens
 *  from chat/code too (`onModelSettings` callers) — same reasoning as Batch 6's `MessageBubble`:
 *  the dialog's own identity is what it's about, not wherever it happens to be embedded.
 *  `load_model_with_settings` is deliberately its own action, not folded into Batch 3's
 *  `load_model` (`ModelsScreen`'s card button) — that one loads with saved/default settings,
 *  this one loads with whatever is currently in the (possibly just-edited) draft, a real
 *  difference in what gets sent to the engine. `set_model_setting_option` folds two visually
 *  distinct but structurally identical generic picker components (`Segmented`, `SpecSegmented`)
 *  used for several unrelated settings fields (split mode, RoPE scaling, speculative decoding
 *  strategy) — same reasoning as folding `FilterChip`/`ActionBtn`'s generic relays elsewhere,
 *  just applied to a picker instead of a plain button. `reset_model_setting_field`/
 *  `remove_model_setting_chip` are similarly generic across whichever specific field a
 *  `DefaultableNumberInput`/`ChipListInput` happens to back. Most of this dialog's controls
 *  (`Toggle`, `Slider`) take a plain `onChange` prop rather than `onCheckedChange`/
 *  `onValueChange`, so they never matched the grep selector at all — a real, larger blind spot
 *  than the usual overcounting the batch-2 note describes, left as-is for the same reason: the
 *  raw counts are directional estimates, not a coverage guarantee, and going beyond what the
 *  selector catches is out of scope for a per-file batch.
 *
 *  Batch 12 (Phase 6l): `screens/engines/BuildGuideDialog.tsx` — 10 raw matches, 10 new
 *  distinct actions, no skips. `dismiss_build_success` (the post-build "Done" button on the
 *  celebratory success screen) is kept separate from `close_build_guide` (the dialog's plain
 *  "Close") — one confirms a completed build was seen, the other abandons the dialog with no
 *  build having happened, a real difference worth keeping visible.
 *
 *  Batch 13 (Phase 6m): `screens/agents/AgentEditPage.tsx` — 10 raw matches, 7 new distinct
 *  actions, 1 skip. All three `goBack` call sites (the error state's "Back to agents", the
 *  header chevron, and the header's own "Cancel" button) call the exact same function with the
 *  exact same effect (navigate to `/customize`, no side effect), so they fold into one
 *  `back_to_agents` tracked once inside `goBack` itself — same pattern as Batch 5's
 *  `back_to_routines`. The inline delete-confirm row's "Delete agent" link only opens the
 *  confirm row (`setDeleteConfirm(true)`); per the "track the outcome, not the request" rule,
 *  it is skipped in favor of tracking `delete_agent` at the confirm row's own "Delete" button.
 *  Its "Cancel" (`setDeleteConfirm(false)`, dismissing the inline row without navigating) is
 *  tracked separately as `cancel_delete_agent` — a different action from `back_to_agents`,
 *  since it doesn't leave the page.
 *
 *  Batch 14 (Phase 6n): `screens/code/CodeHomeScreen.tsx` — 9 raw matches, 2 new distinct
 *  actions, 5 reused, 2 skips. This is the file the Batch 10 note pointed at: its
 *  `onSubmit={() => void send()}` is the ONE `CodeComposer` caller that was never tracked
 *  anywhere — tracked here, finally, as `send_code_message`, the same action
 *  `CodeSessionScreen.tsx` already uses (Batch 8), closing the coverage gap Batch 10 flagged.
 *  The two `FsBrowser` instances here reuse existing actions rather than inventing new ones:
 *  choosing a repo via "Browse…" is the same real effect (`chooseRepo`) as picking one from the
 *  recent-repos dropdown that `CodeComposer` itself already tracks as `select_code_repo` (Batch
 *  10) — same state change, different entry point, same "shared action across entry points"
 *  reasoning as every prior batch's folds; the context-file browser reuses
 *  `add_code_context_file` (Batch 8) for the identical reason. Skips: the sidebar's `onSelect`
 *  relay (Batch 2 already tracks it) and `CodeComposer`'s `onValueChange` keystroke sync (same
 *  category as every prior batch's).
 *
 *  Batch 15 (Phase 6o): `screens/engines/AddEngineDialog.tsx` — 8 raw matches, 6 new distinct
 *  actions, no skips. The confirm step's "Back" and the not-found step's "Back" both call the
 *  identical `setStep('choose')`, so they fold into one `back_to_add_engine_choose`; the
 *  not-found step's "Pick the binary directly" calls the identical `setBrowse('file')` as the
 *  choose step's own link, so it reuses `browse_new_engine_binary` rather than getting a new
 *  name for the same effect from a different step. `select_new_engine_path` is tracked at the
 *  shared `FsBrowser`'s own `onSelect` call site (this file's real DOM click, driving the
 *  scan), same as every other batch's `FsBrowser` usage.
 *
 *  Batch 16 (Phase 6p): `screens/skills/SkillEditPage.tsx` — 7 raw matches, 4 new distinct
 *  actions, 1 skip. Structurally identical to Batch 13's `AgentEditPage.tsx`: all three
 *  `goBack` call sites fold into `back_to_skills`, and the inline delete-confirm row's opening
 *  link is skipped in favor of tracking `delete_skill` at the confirm row's own button, same
 *  "track the outcome, not the request" reasoning.
 *
 *  Batch 17 (Phase 6q): `screens/models/HfRepoDialog.tsx` — 7 raw matches, 6 new distinct
 *  actions, 1 skip. The one skip is `QuantDropdown`'s `onSelect` prop, wired at its call site
 *  (`onSelect={setSelected}`) to a LOCAL component defined later in the same file — the real
 *  click is `QuantDropdown`'s own `DropdownMenuItem`, tracked there as `select_hf_quant`, not
 *  at the pass-through prop. `download_hf_model` (the safetensors/MLX-family whole-repo
 *  download, `MlxRepoBody`) is kept distinct from `download_hf_quant` (the GGUF single-file
 *  download) — genuinely different downloads, not just two labels on the same button.
 *
 *  Batch 18 (Phase 6r): `screens/engines/ManagedEngines.tsx`'s `LlamaCppBackendRows` — 7 raw
 *  matches, ZERO new actions. This component is a second, flat-list UI (rendered inside
 *  `EnginesScreen.tsx`'s catalog) for managing the exact same official llama.cpp backend
 *  variants Batch 1 already covers — Download/Update/Enable/Disable/set-policy/Delete here are
 *  the identical underlying mutations as `EnginesScreen.tsx`'s own `EngineCard` buttons, just a
 *  different physical control for the same action, so every one of them reuses Batch 1's
 *  `install_engine`/`update_engine`/`enable_engine`/`disable_engine`/
 *  `set_engine_update_policy`/`delete_engine` rather than inventing near-duplicate names. The
 *  one skip is the Delete menu item, which only opens the confirm dialog
 *  (`setDeleteTarget(...)`) — `delete_engine` is tracked at the `AlertDialogAction` that
 *  actually fires the delete, same "track the outcome, not the request" rule as every prior
 *  batch's confirm dialogs.
 *
 *  Batch 19 (Phase 6s): `screens/engines/FsBrowser.tsx` — 6 raw matches, 5 new distinct
 *  actions. Screen tagged `engines` (the file's own directory-implied identity, same
 *  reasoning as Batch 11's `ModelDetailDialog`) even though every caller across chat/code/
 *  models/engines embeds this same dialog. Two of the six matches are skipped, one fully and
 *  one partially, for the SAME reason Batch 10/14 skipped `CodeComposer`'s `onSubmit`: this
 *  dialog's `choose(p)` calls the CALLER-supplied `onSelect` prop, which every existing caller
 *  already tracks at its own call site (`add_model_dir`, `add_code_context_file`,
 *  `select_code_repo`, `select_new_engine_path`, etc.) — tracking here too would double-count.
 *  The "Select this folder" button (always routes through `choose`) is fully skipped; the file
 *  list's row click is a single ternary handler (`e.isDir ? setPath(...) : choose(...)`) so
 *  only its directory branch is tracked, as `open_fs_folder` — its file-select branch stays
 *  untracked for the same double-count reason. `navigate_fs_up`/`navigate_fs_to_path`/
 *  `refresh_fs_browser`/`cancel_fs_browser` are genuinely local to this dialog (no caller
 *  callback involved) and are tracked normally.
 *
 *  Batch 20 (Phase 6t): `screens/skills/SkillsLibrary.tsx` — 5 raw matches, 4 new distinct
 *  actions, no skips. `SkillCard`'s `onClick={onOpen}` is tracked inside the card itself
 *  (`open_skill`) rather than at its one call site — same reasoning as Batch 17's
 *  `QuantDropdown`: a same-file local component with a single instantiation, so there's no
 *  double-count risk tracking at the real DOM click. `create_skill` folds the header's "New
 *  skill" button with the empty-state's "Create your first skill" — both navigate to the
 *  identical `/skills/new` route. */
export const UI_ACTIONS = [
  'install_engine', 'enable_engine', 'disable_engine', 'update_engine', 'delete_engine',
  'switch_engine', 'switch_engine_build', 'set_engine_update_policy',
  'toggle_manage_builds', 'open_build_guide', 'open_rebuild_guide',

  'open_conversation', 'rename_conversation', 'delete_conversation', 'move_conversation_to_folder',
  'new_folder', 'rename_folder', 'delete_folder',
  'open_code_session', 'rename_code_session', 'archive_code_session', 'delete_code_session', 'filter_code_sessions',
  'open_routine',
  'toggle_sidebar_collapsed', 'new_chat', 'new_code_session', 'new_routine', 'import_chat',

  'switch_models_tab', 'filter_models', 'open_model_folders', 'rescan_models', 'toggle_incompatible_models',
  'select_model_quant', 'eject_model', 'load_model', 'open_model_load_settings', 'pin_model',
  'find_model_quants', 'delete_model', 'set_primary_model_dir', 'remove_model_dir',
  'browse_model_dir', 'add_model_dir',

  'switch_customize_tab', 'close_mcp_panel', 'connect_mcp_server', 'add_local_mcp_server',
  'add_manual_mcp_server', 'update_mcp_server', 'cancel_mcp_edit', 'select_builtin_search',
  'save_builtin_search', 'switch_mcp_tab', 'filter_mcp_category', 'select_mcp_catalog_entry',
  'edit_mcp_server', 'delete_mcp_server', 'open_manual_mcp_form',

  'back_to_routines', 'create_routine', 'edit_routine', 'discard_routine_edit',
  'review_routine_edit', 'pause_routine', 'resume_routine', 'run_routine_now',
  'delete_routine', 'select_routine_run',

  'toggle_thinking_block', 'toggle_tool_call_detail', 'toggle_source_row', 'toggle_sources_panel',
  'open_edit_message', 'cancel_edit_message', 'save_edited_message', 'save_edited_reply',
  'delete_message', 'regenerate_message', 'switch_message_variant',

  'open_model_settings', 'copy_chat_link', 'copy_chat_debug_info', 'export_chat',
  'dismiss_import_banner', 'use_suggested_prompt', 'scroll_to_latest', 'dismiss_clipboard_modal',
  'select_skill_from_picker', 'remove_attachment', 'attach_file', 'stop_generation', 'send_message',

  'export_code_session', 'open_code_git_dialog', 'back_to_code', 'resume_code_session',
  'send_code_message', 'add_code_context_file', 'revert_code_chat', 'revert_code_chat_and_files',

  'switch_settings_tab', 'set_theme', 'save_settings', 'install_comfyui_gate',
  'uninstall_comfyui_gate', 'test_hf_token', 'save_hf_token', 'toggle_telemetry_preview',
  'toggle_submission_log', 'regenerate_machine_id', 'restart_daemon', 'dismiss_restart_overlay',
  'reload_after_restart', 'save_personalization',

  'select_code_slash_command', 'select_code_file_mention', 'select_code_repo', 'browse_code_repo',
  'select_code_base_branch', 'remove_code_context_file', 'remove_code_image', 'set_code_mode',
  'open_code_context_browser', 'stop_code_generation',

  'view_model_hf_repo', 'toggle_model_advanced_settings', 'load_model_with_settings',
  'save_model_settings', 'reset_model_settings', 'dismiss_autotune_result', 'save_autotune_result',
  'cancel_autotune', 'start_autotune', 'reset_model_setting_field', 'set_model_setting_option',
  'remove_model_setting_chip',

  'remove_build_search_dir', 'add_build_search_dir', 'recheck_build_prereqs',
  'copy_build_commands', 'close_build_guide', 'open_manual_build_handoff', 'start_engine_build',
  'dismiss_build_success', 'cancel_engine_build', 'download_cuda_toolkit',

  'toggle_agent_tool_group', 'back_to_agents', 'reset_agent_to_default', 'save_agent',
  'switch_agent_form_tab', 'delete_agent', 'cancel_delete_agent',

  'switch_code_stats_range', 'use_starter_task',

  'browse_new_engine_folder', 'browse_new_engine_binary', 'cancel_add_engine',
  'back_to_add_engine_choose', 'submit_new_engine', 'select_new_engine_path',

  'back_to_skills', 'save_skill', 'delete_skill', 'cancel_delete_skill',

  'load_hf_quant', 'download_hf_quant', 'select_hf_quant', 'download_hf_model',
  'search_hf_from_error', 'retry_hf_repo_load',

  'navigate_fs_up', 'navigate_fs_to_path', 'refresh_fs_browser', 'open_fs_folder',
  'cancel_fs_browser',

  'open_skill', 'upload_skill_file', 'create_skill', 'learn_skill_from_folder',
] as const

export const uiAction = defineEvent({
  name: 'ui_action',
  since: 2,
  consent: 'full',
  lifecycle: 'per-action',
  description: 'One interactive-element click — the generic click-stream event so full UI coverage never requires a new schema entry per button.',
  payload: {
    screen: f.enum(SCREENS),
    action: f.enum(UI_ACTIONS),
  },
})

export const uiDaily = defineEvent({
  name: 'ui_daily',
  since: 2,
  consent: 'full',
  lifecycle: 'daily-rollup',
  description: "Yesterday's ui_action volume for one screen, so per-click volume stays bounded without needing raw per-click counts anywhere else.",
  payload: {
    screen: f.enum(SCREENS),
    actions: f.int(),
    distinctActions: f.int(),
  },
})
