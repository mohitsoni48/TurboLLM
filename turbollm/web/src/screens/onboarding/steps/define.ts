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
