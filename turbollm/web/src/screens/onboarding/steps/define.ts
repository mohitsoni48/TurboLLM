/** The step descriptor template (spec 25 §9.1, ADR-340).
 *
 *  Deliberately mirrors `src/telemetry/core/define.ts`: a declarative
 *  descriptor consumed by a generic engine, so that adding a step touches
 *  exactly ONE file and every derived view — the ordered list, the test
 *  fixtures, the `ui_action` enum — falls out of the same declaration.
 *
 *  Why not a linked list: the sequence is conditional, so `next` would have to
 *  be `next(state)` — a transition function, not a list. And resume must
 *  survive a tab close and Pro's navigate-away Discover handoff, which means
 *  persisting a serialisable step ID rather than a pointer. Finally, the
 *  skip-coverage test requires STATIC enumeration of every step; a list with a
 *  state-dependent `next` cannot provide that. */

export type ProfileId = 'casual' | 'developer' | 'enthusiast' | 'pro'

export interface StepContext {
  profile: ProfileId | null
  /** True once the model is present locally — lets the download-shadow steps drop out. */
  downloadDone: boolean
  /** CPU-only or <4 GB VRAM. Suppresses auto-tune for ALL profiles (§6.2). */
  isT0: boolean
  recommendationKind: 'entry' | 'discover' | 'hf-search' | null
  /** The model key LoadStep should treat as "the one this run is waiting
   *  for". Set directly by a step that already knows the exact key with no
   *  download to match against (ModelStep's "use a model I already have"
   *  path). Null when LoadStep should fall back to matching a finished
   *  download instead. Added after an adversarial QA pass found LoadStep
   *  advancing the instant ANY model was already loaded in the engine — a
   *  leftover from prior use, unrelated to what this run actually requested. */
  expectedModelKey: string | null
  /** The id of the specific download record LoadStep should wait for — set by
   *  ModelStep's real "Download this" path (`startDownload()`) right after
   *  `enqueueDownload()` returns, since the model's eventual key isn't known
   *  until the file exists and gets scanned (unlike `expectedModelKey`, which
   *  IS known upfront for the "use a model I already have" path). Null when
   *  LoadStep should fall back to matching the most-recent finished download
   *  instead (the "use existing" path, or a post-reload resume with no trail
   *  left). Added after `matchedEntry`'s "most recent .done record in the
   *  WHOLE history" heuristic was found live to match an older, unrelated,
   *  already-loaded model while a genuinely new download from THIS run was
   *  still in flight — the wizard advanced instantly to a model that had
   *  nothing to do with what the user just started downloading. */
  expectedDownloadId: string | null
  /** True once LoadStep has auto-advanced past load for this session — never
   *  reset. Without this, pressing Back from Payoff (a normal interaction,
   *  not an edge case, now that Payoff no longer exits the wizard
   *  immediately) landed on Load, which re-ran its own "the expected model
   *  is already loaded" check and instantly auto-advanced forward again —
   *  Back appeared to silently do nothing. Found by adversarial QA. */
  loadCompletedOnce: boolean
}

export interface StepDescriptor {
  id: string
  title: string
  /** Pure predicate. Must not read globals — it is called in tests with
   *  synthetic contexts covering hardware nobody owns. */
  appliesTo(ctx: StepContext): boolean
  /** ALWAYS true. Set by `defineStep`, never by the caller: a step cannot
   *  declare itself unskippable. Structural enforcement of spec 25 §3.1,
   *  the same way the telemetry Template Method makes `gate()` final. */
  readonly skippable: true
}

export function defineStep(d: Omit<StepDescriptor, 'skippable'>): StepDescriptor {
  return { ...d, skippable: true }
}
