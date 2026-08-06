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
 *  `chat_daily` already applies to actual message counts). */
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
