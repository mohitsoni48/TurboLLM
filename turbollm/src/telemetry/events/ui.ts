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

/** First batch instrumented (Phase 6a): `EnginesScreen.tsx` + its `EngineCard`/
 *  `CustomEngineCard` sub-components — 18 handler sites, 11 distinct actions (several
 *  handlers share an action across surfaces, e.g. the inline "Update" button and the
 *  overflow menu's "Update now" both fire `update_engine`). */
export const UI_ACTIONS = [
  'install_engine', 'enable_engine', 'disable_engine', 'update_engine', 'delete_engine',
  'switch_engine', 'switch_engine_build', 'set_engine_update_policy',
  'toggle_manage_builds', 'open_build_guide', 'open_rebuild_guide',
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
