/** UI click-stream (spec 23 §3.8, ADR-333, "every clickable element"). One generic event so
 *  full coverage never needs a new schema entry per button — adding a button is one enum
 *  value (`UI_ACTIONS`) plus one `track(screen, action)` call site.
 *
 *  `SCREENS` is spec 23's list, corrected against the actual frontend (`web/src/screens/`):
 *  spec 25 added the `onboarding` screen (the wizard's 9-step flow). Everything else
 *  matches a real top-level screen file.
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
  'workspace', 'developer', 'routines', 'agents', 'skills', 'onboarding',
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
 *  identical `/skills/new` route.
 *
 *  Batch 21 (Phase 6u): `screens/code/CodeTranscript.tsx` — 5 raw matches, 2 new distinct
 *  actions, 1 skip. `toggle_code_tool_detail` folds `CodeToolLine`'s single-call expand/collapse
 *  with `CodeToolGroup`'s grouped-bash-run expand/collapse — same conceptual action at two
 *  granularities. The reasoning-block toggle reuses Batch 6's `toggle_thinking_block` across
 *  screens (chat/code render the same underlying concept in different transcript styles), same
 *  cross-screen reuse as `toggle_sidebar_collapsed`/`scroll_to_latest`. The skip is
 *  `CodeInstructionEntry`'s "Revert to this message" — it only opens the confirm dialog
 *  (`openRevertConfirm`, wired from `CodeSessionScreen.tsx`); the confirmed outcome is already
 *  tracked as `revert_code_chat`/`revert_code_chat_and_files` at Batch 8's `AlertDialogAction`
 *  buttons, so tracking the opening click too would count the same revert twice.
 *
 *  Batch 22 (Phase 6v): `components/routines/RoutineConfirmCard.tsx` — 5 raw matches, 5 new
 *  distinct actions, no skips. Screen tagged `routines` (its own directory's identity) even
 *  though it also renders inline in the chat transcript (`MessageBubble.tsx`'s tool-call
 *  cards) — same reasoning as every other cross-embedded shared component this session.
 *  `cancel_routine_confirm`'s own `cancel()` function calls `props.onCancelled()`, which
 *  `RoutineEditPage.tsx` wires to its own `goBack` (already firing `back_to_routines`, Batch
 *  5) — this is NOT the double-count case the Batch 5 note warned about: that note applies
 *  only if a button were a bare passthrough to `onCancelled` with no logic of its own, whereas
 *  `cancel()` has real behavior first (a DELETE in create mode) before calling it, so
 *  `cancel_routine_confirm` is a genuinely distinct, more specific action layered on top of
 *  whatever the caller's `onCancelled` does — not a duplicate of it.
 *
 *  Batch 23 (Phase 6w): `screens/routines/RoutinesPanel.tsx` — 4 raw matches, ZERO new
 *  actions. This is Routines mode's bare landing state (same role `CodeHomeScreen.tsx` plays
 *  for Code) — its mobile sidebar backdrop/hamburger reuse `toggle_sidebar_collapsed` (Batch
 *  5), its "New routine" empty-state button reuses `new_routine` (Batch 2, `ConversationSidebar`'s
 *  own "+ New" button in routines mode — same route, same effect), and the sidebar's `onSelect`
 *  is the usual `ConversationSidebar` relay skip.
 *
 *  Batch 24 (Phase 6x): `screens/models/DiscoverTab.tsx` — 4 raw matches, 2 new distinct
 *  actions, 2 skips. `select_discover_result` is tracked at the real DOM click —
 *  `ListRow`'s own `onClick={onSelect}` — not at either of the two pass-through layers above
 *  it (`ResultListRow`'s `onSelect={onSelect}` forwarding straight through, and
 *  `DiscoverTab`'s own `onSelect={() => setSelectedRepo(r.repo)}` prop supply): all three
 *  raw-match the grep selector for what is structurally ONE click, so only the innermost real
 *  button gets tracked, same "track at the real DOM click, not the relay" rule as every prior
 *  local-component case (`QuantDropdown`, `SkillCard`).
 *
 *  Batch 25 (Phase 6y): `screens/engines/EngineRow.tsx` — SKIPPED, not instrumented.
 *  Verified (`grep -rn "EngineRow"` across both `web/src` and `src`) that this component is
 *  exported but never imported or rendered anywhere in the app — dead code present since the
 *  original MVP commit, not a recent regression. Instrumenting an unreachable component would
 *  add `UI_ACTIONS` enum values that can never fire in production, which is worse than no
 *  coverage at all for a founder who explicitly does not want "wrong/half data." Flagged
 *  separately for its own cleanup pass (delete or wire up) rather than fixed inline here, since
 *  that's out of scope for a telemetry-instrumentation batch. `screens/chat/ToolApprovalBar.tsx`
 *  — 4 raw matches, 4 new distinct actions, no skips, folded into the same batch since
 *  `EngineRow.tsx` needed no code change. All four buttons call the same shared `respond(decision)`
 *  function with a different `Decision` value each; each is tracked as its own action rather than
 *  one generic "responded" action, since deny/allow/allow-for-chat/always-allow are materially
 *  different trust decisions worth keeping distinguishable in the data — same reasoning as
 *  Batch 8's chat-vs-chat+files revert split. Screen tagged `chat` (its own directory) even
 *  though it also renders inline in Code mode (`CodeSessionScreen.tsx`), same cross-embedded
 *  reasoning as `MessageBubble`/`RoutineConfirmCard`.
 *
 *  Batch 26 (Phase 6z): `screens/agents/AgentsLibrary.tsx` — 4 raw matches, 3 new distinct
 *  actions, no skips. `AgentCard`'s own click (`open_agent_card`) is tracked inside the
 *  card, same local-component reasoning as `SkillCard`. Its "Reset to default" icon reuses
 *  Batch 13's `reset_agent_to_default` (`AgentEditPage.tsx`) — both call the identical
 *  `useBuiltinAgentOverrideMutations().reset` mutation, just from a different surface (the
 *  library grid's own reset icon vs. the edit page's "Reset to default" button).
 *
 *  Batch 27 (Phase 6aa): `screens/DeveloperScreen.tsx` — 4 raw matches, 3 new distinct
 *  actions, 1 skip. `select_connect_cli` is tracked inside `AppCard`'s own `onClick={onSelect}`
 *  — the real DOM click — not at `ConnectSection`'s `onSelect={() => setSelected(c.id)}` prop
 *  supply, same "track at the real DOM click, not the relay" rule as every prior local-component
 *  case, even though `AppCard` here has multiple instantiations (one per CLI in the grid) rather
 *  than the usual single-instance case — the reasoning still holds since there's only one real
 *  click per row regardless of how many rows exist.
 *
 *  Batch 28 (Phase 6bb): `components/routines/RoutineFormFields.tsx` — 4 raw matches, 4 new
 *  distinct actions, no skips. Screen tagged `routines` (its own directory's identity) even
 *  though it also embeds inline in the chat transcript's confirm card (the file's own doc
 *  comment: "Both surfaces that create/edit a routine embed this same component"), same
 *  cross-embedded reasoning as `RoutineConfirmCard`. `select_routine_workspace` is tracked at
 *  this file's own `<FsBrowser onSelect={...}>` call site (the real mutation — `onChange({
 *  ...draft, workspacePath: p })`), not skipped, because THIS is the caller-level call site
 *  that Batch 19's `FsBrowser.tsx` itself deliberately left untracked (its shared `choose()`
 *  relays into whichever caller supplies `onSelect` — tracking belongs at the caller, exactly
 *  like every other `FsBrowser` embedding this session).
 *
 *  Batch 29 (Phase 6cc): `screens/models/ModelDirs.tsx` — 3 raw matches, ZERO new actions.
 *  This is the OLD paste-an-absolute-path panel embedded in `SettingsScreen.tsx`;
 *  `ModelsScreen.tsx`'s own `ModelFoldersDialog` (its doc comment: "replacing the old
 *  paste-an-absolute-path panel that sat above the model list") is a newer, dialog-based
 *  second UI over the exact same three mutations (`setPrimaryDir`/`removeDir`/`addDir`) —
 *  same "second UI, same real objects" pattern as Batch 18's `ManagedEngines.tsx`. All three
 *  reuse Batch 3's `set_primary_model_dir`/`remove_model_dir`/`add_model_dir`, tagged `models`
 *  (this file's own directory identity, same reasoning as Batch 22/28's `routines` tag) rather
 *  than `settings` (the screen it happens to be embedded in here).
 *
 *  Batch 30 (Phase 6dd): `screens/settings/CodeContextSection.tsx` — 3 raw matches, 3 new
 *  distinct actions, no skips, tagged `settings` (its only embedding). All three live inside
 *  the shared `CandidateList` component, tracked at its own real clicks — same "track inside
 *  the reusable component" rule as `SkillCard`/`AgentCard`/`AppCard` — even though it's
 *  instantiated twice (the project-file list and the global-file list). Not split into
 *  per-list action variants: unlike Batch 12's `dismiss_build_success`/`close_build_guide`
 *  split (a real behavioral difference), editing the project list vs. the global list is the
 *  identical action on the identical component with no behavioral difference, only a different
 *  target list — `add_context_candidate`/`remove_context_candidate` cover both instantiations,
 *  `save_context_candidates` likewise (`add_code_context_file`, Batch 8, names an unrelated
 *  action — attaching a file to a live Code session's context — not this file's
 *  AGENTS.md-candidate-list editor).
 *
 *  Batch 31 (Phase 6ee): `screens/code/CodeGitDialog.tsx` — 3 raw matches, 3 new distinct
 *  actions, no skips, tagged `code` (its only embedding, `CodeSessionScreen.tsx`'s Git action).
 *  `close_code_git_dialog` follows the established "a dialog's own dismissal is tracked, not
 *  skipped" precedent (`close_build_guide`, `close_mcp_panel`) rather than being folded into
 *  anything else.
 *
 *  Batch 32 (Phase 6ff): `components/ModelLoadMenu.tsx` — 3 raw matches, ZERO new actions. The
 *  Chat/Code header's model dropdown is a second UI over the exact same three real objects as
 *  `ModelsScreen.tsx`'s own list-row buttons (Batch 3) — loading, ejecting, and opening
 *  pre-load settings for a model — same "second UI, same real objects" pattern as Batch 18/29.
 *  Unlike those two (single reuse-screen each), this component has no screen of its own — it's
 *  embedded in both `ChatScreen.tsx` and `CodeComposer.tsx` — so it takes an explicit `screen`
 *  prop threaded from each caller and reuses `load_model`/`eject_model`/
 *  `open_model_load_settings` tagged dynamically per embedding, the same "same action, screen
 *  reflects wherever the click really happened" pattern `toggle_sidebar_collapsed` already
 *  established across chat/code/routines.
 *
 *  Batch 33 (Phase 6gg): `screens/models/DownloadsPanel.tsx` — 3 raw matches, 3 new distinct
 *  actions, no skips, tagged `models` (its only embedding, `DiscoverTab.tsx`). All three live
 *  inside the local `DownloadRow` component, whose `onCancel`/`onRemove`/`onResume` props are
 *  supplied inline in the SAME file by `DownloadsPanel` itself (the real `mut.*.mutate()`
 *  calls) — same "local component, same file" pattern as `CandidateList`/`AgentCard`, tracked
 *  at the real click. Distinct from `download_hf_model`/`download_hf_quant` (Batch 17), which
 *  cover STARTING a download, not managing one already in flight.
 *
 *  Batch 34 (Phase 6hh): `screens/chat/ConversationSettingsDialog.tsx` — 3 raw matches, 3 new
 *  distinct actions, no skips, tagged `chat` (its only embedding). `reset_thread_sampling` and
 *  `save_thread_settings` are kept distinct from Batch 11's `reset_model_settings`/
 *  `save_model_settings` — those act on a MODEL's own load settings, these act on a per-THREAD
 *  sampling-override map (temperature/top_p/top_k/min_p for this conversation only) plus
 *  system prompt/skills/preserveThinking — genuinely different real objects, not the same
 *  action reused across screens. `toggle_preserve_thinking` covers the Switch (GitHub #52).
 *  The skills-picker checkboxes (`toggleSkill`/`toggleAllSkills`) use plain `onChange` on
 *  native `<input type="checkbox">`, not `onCheckedChange`/`onClick` — outside this batch's
 *  raw-match grep pattern, same scope boundary every other batch has used.
 *
 *  Batch 35 (Phase 6ii): `components/ArtifactCard.tsx` — 3 raw matches, 3 new distinct
 *  actions, no skips, tagged `chat` (its only embedding, `MessageBubble.tsx`, not rendered in
 *  `CodeTranscript.tsx`). `download_artifact` folds every export format (png/svg/gif/html)
 *  into one action — same "same local function, different param source" pattern as Batch 9's
 *  `install_comfyui_gate` — rather than splitting per format the way Batch 17 split
 *  `download_hf_model`/`download_hf_quant`, since those cover genuinely different DOWNLOAD
 *  SCOPES (whole repo vs. one file) while these are just export-format variants of the same
 *  single artifact.
 *
 *  Batch 36 (Phase 6jj): four small files (2 raw matches each, 8 total) shipped together as
 *  one PR — the remaining backlog is entirely 1-2 handler files, so batching several trivial,
 *  mutually-independent files per PR avoids repeating a full deploy/verify/PR cycle 18 times
 *  for files this small, while every file still gets its own classification below and its own
 *  live-verify:
 *  - `screens/settings/ToolPermissionsSection.tsx` — 2 new actions, no skips, tagged
 *    `settings` (its only embedding). `toggle_auto_allow_tools` and `set_tool_policy` are
 *    persistent per-tool/global CONFIG, genuinely different from Batch 25's
 *    `allow_tool_call`/`deny_tool_call`/etc., which are live, per-INSTANCE approval decisions
 *    on one in-flight tool call in a running chat.
 *  - `screens/models/ImportUrlDialog.tsx` — 2 new actions, no skips, tagged `models` (its only
 *    embedding, `DiscoverTab.tsx`). `close_import_url_dialog` follows the established "a
 *    dialog's own dismissal is tracked" precedent. `import_model_url` covers the submit button
 *    for BOTH its real outcomes (enqueuing a direct download vs. routing to the repo's quant
 *    picker) — unlike Batch 8's revert-dialog split, the downstream `model_downloaded` event
 *    already distinguishes whether a download actually happened, so forking this click by
 *    outcome adds no analytics value the click itself doesn't already provide.
 *  - `screens/engines/EngineStatusHeader.tsx` — 1 new action, 1 reuse, no skips, tagged
 *    `engines`. `onStop` calls the exact same `useModelActions().eject` mutation as Batch 3's
 *    `eject_model` — a THIRD UI surface for the identical real object (after `ModelsScreen`
 *    and Batch 32's `ModelLoadMenu`), so it reuses `eject_model` rather than inventing a
 *    duplicate. `restart_engine` is new — distinct from the unrelated `restart_daemon` (that
 *    restarts the whole TurboLLM process, not one llama-server engine).
 *  - `screens/engines/CustomBuildDialog.tsx` — 2 new actions, no skips, tagged `engines`.
 *    `cancel_custom_build_dialog` and `continue_custom_build_dialog` are this self-service
 *    "Add via git repo" pre-form's own steps (ADR-183/184) — distinct from Batch 12's
 *    `BuildGuideDialog.tsx` actions, which cover the guide dialog THIS form hands off into,
 *    not this form itself.
 *
 *  Batch 37 (Phase 6kk): twelve single/simple-embedding files (16 raw matches, 16 new
 *  actions) shipped together — the last of the backlog with a single, unambiguous screen
 *  each. Two cross-screen shared primitives (`components/ui/copy-button.tsx`,
 *  `components/common.tsx`'s `InlineError`) are deliberately NOT in this batch — their
 *  fan-out across a dozen call sites each is its own batch (37) below.
 *  - `components/routines/RoutineApprovalCard.tsx` — tagged `routines` (its only embedding,
 *    `RoutineEditPage.tsx`). `approve_routine_tool_call`/`deny_routine_tool_call` are the
 *    ROUTINE-run equivalent of Batch 25's `allow_tool_call`/`deny_tool_call` — a different
 *    real object (a parked routine run's blocked call, not a live chat's in-flight one), same
 *    reasoning as Batch 34 keeping thread-sampling distinct from model-settings actions.
 *  - `components/EngineProvisionBanner.tsx` and `components/EngineLoadErrorBanner.tsx` — both
 *    render globally from `Shell.tsx` (visible on every screen), tagged `engines` by
 *    conceptual identity (what they're ABOUT) rather than wherever the user happens to be
 *    standing — same reasoning as Batch 6's `MessageBubble`/Batch 11's `ModelDetailDialog`.
 *    `cancel_engine_provision` is a distinct real mutation (`useBackendInstall().cancel`,
 *    the default-engine auto-provision flow, ADR-024) from Batch 12's `cancel_engine_build`
 *    (a custom SOURCE build, ADR-089/100) — not a reuse.
 *  - `screens/tokens/ModelsTab.tsx` — tagged `tokens` (`TokensScreen.tsx` only).
 *    `show_more_token_models` for the "Show N more" expand button.
 *  - `screens/settings/MemorySection.tsx` — tagged `settings`. `delete_memory_fact` for the
 *    per-fact delete button — the master enable/disable toggle is a native
 *    `<input type="checkbox" onChange=...>`, outside this batch's raw-match grep pattern,
 *    same scope boundary as Batch 34's skills checkboxes.
 *  - `screens/engines/EngineLogPanel.tsx` — tagged `engines` (its only real embedding,
 *    `EnginesScreen.tsx` — the other textual match of its name, in `CodeTranscript.tsx`, is
 *    just a comment referencing its log-color convention, not an import).
 *    `toggle_engine_log_autoscroll` for the auto-scroll Switch.
 *  - `screens/settings/CodeAgentSection.tsx` — tagged `settings`. `set_default_code_agent`
 *    for the agent picker.
 *  - `screens/code/ContextUsageRing.tsx` — tagged `code` (all three embeddings —
 *    `TerminalToolbar`/`CodeComposer`/`CodeStatsFooter` — are Code-only).
 *    `open_context_usage_detail` for the ring button that opens the detail sheet.
 *  - `screens/code/CodeResourcesHeader.tsx` — tagged `code` (`CodeSessionScreen.tsx` only).
 *    `toggle_code_resources_header` for the collapsible trigger.
 *  - `screens/TokensScreen.tsx` — tagged `tokens`. The one raw match (`onClick=`) is inside
 *    this file's own local `Segmented` component, instantiated twice for two SEMANTICALLY
 *    DIFFERENT purposes (switching the overview/models/api tab vs. switching the date range)
 *    — unlike `CandidateList`/`DownloadRow`'s same-action-both-instantiations case, folding
 *    these into one action would erase a real distinction, and `Segmented` itself has no way
 *    to know which purpose it's serving. So tracking is NOT inside `Segmented`'s own click —
 *    it's at the two caller-supplied `onChange={...}` props in `TokensScreen` itself (still
 *    the same file, just the outer component instead of the inner one), as
 *    `switch_token_tab`/`switch_token_range`.
 *  - `components/Shell.tsx` — tagged `engines` for this one action (by destination, not by
 *    Shell's own — nonexistent — screen identity): `open_engines_from_nav_chip`, the engine
 *    state chip at the bottom of the nav rail. Every other nav item is a plain `<Link>` with
 *    no handler of its own (React Router's own navigation, not a raw match) — this chip alone
 *    uses an explicit `onClick`+`navigate` because it is styled as a status indicator, not a
 *    nav link.
 *  - `components/AuthGate.tsx` — tagged `developer` (API keys are managed under the Developer
 *    screen, even though this gate itself renders outside any screen route on a 401).
 *    `submit_auth_key` for the "Connect" button.
 *
 *  Batch 38 (Phase 6ll): the last two files in the backlog — both cross-screen shared UI
 *  primitives whose real surface area is their CALL SITES, not the files themselves. THIS
 *  CLOSES OUT THE ENTIRE PHASE 6 BACKLOG (spec 23 §3.8) — every clickable element across the
 *  app now fires a `track()` call.
 *  - `components/ui/copy-button.tsx` — 1 new action, `copy_button_click`, folding every
 *    copy-to-clipboard button app-wide into one action (same "same local function, different
 *    param source" reasoning as `download_artifact`/`install_comfyui_gate` — copying IS
 *    copying, regardless of what text). Takes a new required `screen` prop (same pattern as
 *    Batch 32's `ModelLoadMenu`), threaded through all 14 real call sites across 6 screens:
 *    `EngineLoadErrorBanner`/`EngineStatusHeader`/`EngineLogPanel` (`engines`),
 *    `ModelDetailDialog` (`models`), `DeveloperScreen` ×4 (`developer`), `SettingsScreen`
 *    (`settings`), `CodeTranscript` ×2 (`code`), `MessageBubble` ×3 (`chat`).
 *  - `components/common.tsx`'s `InlineError` — 1 new action, `retry_failed_load`, for its
 *    Retry button (only rendered when `onRetry` is supplied). Also takes a required `screen`
 *    prop, threaded through all 10 call sites — 7 where the Retry button actually renders
 *    (`TokensScreen`/`ModelsScreen`/`RoutineEditPage`/`DiscoverTab` ×2/`EnginesScreen`/
 *    `FsBrowser`) and 3 where it's plumbed but inert (`AddEngineDialog` ×3, which never pass
 *    `onRetry` — no button, no click, the prop is just there for a consistent required-prop
 *    signature rather than a conditional type). `FsBrowser`'s own embedding varies by CALLER
 *    (routines/models/engines/code all open it) — its internal scan-error retry is tagged
 *    `engines` as the single most representative context rather than threading a second prop
 *    through FsBrowser's own many callers for one inline error message; a reasonable
 *    approximation, called out here rather than silently picked. */
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
  // Model load presets (ADR-353).
  'apply_model_preset', 'create_model_preset', 'rename_model_preset', 'delete_model_preset',

  'remove_build_search_dir', 'add_build_search_dir', 'recheck_build_prereqs',
  'copy_build_commands', 'close_build_guide', 'open_manual_build_handoff', 'start_engine_build',
  'dismiss_build_success', 'cancel_engine_build', 'download_cuda_toolkit',
  // Install a missing build prereq with the host's own package manager (the headless fix:
  // the install LINK opens a page in the operator's browser, not on the daemon machine).
  'install_build_prereq',

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

  'toggle_code_tool_detail', 'send_queued_code_message',

  'cancel_routine_confirm_edit', 'save_routine_confirm_edit', 'edit_routine_confirm',
  'cancel_routine_confirm', 'confirm_routine',

  'open_import_url_dialog', 'select_discover_result',

  'deny_tool_call', 'allow_tool_call', 'allow_tool_call_for_chat', 'always_allow_tool_call',

  'open_agent_card', 'set_default_agent', 'new_agent',

  'revoke_api_key', 'create_api_key', 'select_connect_cli',

  'set_routine_flavor', 'browse_routine_workspace', 'toggle_routine_weekday', 'select_routine_workspace',

  'add_context_candidate', 'remove_context_candidate', 'save_context_candidates',

  'commit_code_git', 'push_code_git', 'close_code_git_dialog',

  'resume_download', 'cancel_download', 'remove_download',

  'reset_thread_sampling', 'toggle_preserve_thinking', 'save_thread_settings',

  'toggle_artifact_interactive', 'toggle_artifact_fit', 'download_artifact',

  'toggle_auto_allow_tools', 'set_tool_policy',
  'close_import_url_dialog', 'import_model_url',
  'restart_engine',
  'cancel_custom_build_dialog', 'continue_custom_build_dialog',

  'approve_routine_tool_call', 'deny_routine_tool_call',
  'dismiss_engine_provision_error', 'cancel_engine_provision',
  'open_engines_from_error_banner', 'dismiss_engine_error_banner',
  'show_more_token_models',
  'delete_memory_fact',
  'toggle_engine_log_autoscroll',
  'set_default_code_agent',
  'open_context_usage_detail',
  'toggle_code_resources_header',
  'switch_token_tab', 'switch_token_range',
  'open_engines_from_nav_chip',
  'submit_auth_key',

  'copy_button_click', 'retry_failed_load',

  // Batch 7 (spec 25): the onboarding wizard. One skip action per registry
  // step — where people bail is the entire diagnostic value of the funnel.
  'skip_onboarding_welcome', 'skip_onboarding_profile', 'skip_onboarding_model',
  'skip_onboarding_personalize', 'skip_onboarding_profile_extra', 'skip_onboarding_load',
  'skip_onboarding_payoff', 'skip_onboarding_tune_offer',
  'choose_profile', 'start_model_download', 'use_existing_models', 'open_discover_handoff',
  'pick_different_model', 'accept_autotune', 'decline_autotune', 'finish_onboarding',
  'resume_onboarding', 'dismiss_finish_banner', 'take_recovery_action',

  // Turbo Link phase 3 (ADR-376): fleet control on the Models screen. `UI_ACTIONS` is a
  // CLOSED enum — `uiAction` validates against it and `POST /api/v1/telemetry/ui` drops an
  // unrecognised action while still answering 202 — so these five call sites existed and
  // recorded nothing at all until they were listed here. ADR-376 makes `ui_action`
  // attribution to the peer that took the click a load-bearing decision, and this project
  // has already once read a telemetry defect as "nobody used it".
  'load_remote_model', 'unload_remote_model', 'filter_models_by_machine',
  'cancel_remote_download', 'download_hf_quant_remote',
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
    /** Whole days back from this event's `ts` that these counts describe —
     *  see `chat.ts` for the full rationale. */
    daysAgo: f.int({ min: 0, max: 366, optional: true }),
  },
})
