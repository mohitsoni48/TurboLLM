/** Failure enum → one-click recovery (spec 25 §7).
 *
 *  The classifiers already exist server-side (`classifyLoadFailure`,
 *  `classifyProvisionFailure`) and were wired only to telemetry. This map is
 *  the missing half: it turns a diagnosis into an action.
 *
 *  The enum members are mirrored here as literal unions rather than imported
 *  from `src/telemetry/` — the web bundle does not import daemon modules. The
 *  `Record<AnyFailure, ...>` below is exhaustive, so adding a member to either
 *  enum without adding a recovery is a COMPILE error, not a runtime dead end. */

export const LOAD_FAILURES = ['oom', 'no_engine', 'bad_gguf', 'unsupported_arch', 'timeout', 'cancelled', 'other'] as const
export const PROVISION_FAILURES = ['network', 'no_asset', 'unsupported_platform', 'disk_full', 'permission_denied'] as const

export type LoadFailure = (typeof LOAD_FAILURES)[number]
export type ProvisionFailure = (typeof PROVISION_FAILURES)[number]
export type AnyFailure = LoadFailure | ProvisionFailure

export type RecoveryActionId =
  | 'retry' | 'use-existing-folder' | 'alt-build-variant' | 'hf-search' | 'llamafile'
  | 'build-from-source' | 'smaller-quant' | 'show-path-fix' | 'lower-quant-retry'
  | 'redownload' | 'alt-engine' | 'longer-timeout' | 'back-to-engine' | 'resume'
  | 'show-launch-command'

export interface RecoveryAction {
  id: RecoveryActionId
  label: string
  primary: boolean
}

const a = (id: RecoveryActionId, label: string, primary = false): RecoveryAction => ({ id, label, primary })

/** Exhaustive by construction. `other` deliberately still offers the launch
 *  command plus diagnostics — the invariant is that NO screen terminates
 *  without a next action. */
const MAP: Record<AnyFailure, RecoveryAction[]> = {
  // Provision
  network: [a('retry', 'Retry download', true), a('use-existing-folder', 'Use models I already have')],
  no_asset: [a('alt-build-variant', 'Try a different build', true), a('hf-search', 'Browse other models')],
  unsupported_platform: [a('llamafile', 'Use llamafile (portable)', true), a('build-from-source', 'Build from source')],
  disk_full: [a('smaller-quant', 'Choose a smaller model', true), a('retry', 'Retry')],
  permission_denied: [a('show-path-fix', 'Show how to fix permissions', true), a('retry', 'Retry')],
  // Load
  oom: [a('lower-quant-retry', 'Retry with a smaller quant', true), a('smaller-quant', 'Choose a smaller model')],
  no_engine: [a('back-to-engine', 'Set up an engine', true)],
  bad_gguf: [a('redownload', 'Re-download the model', true), a('hf-search', 'Choose a different model')],
  unsupported_arch: [a('alt-engine', 'Try an engine that supports it', true), a('hf-search', 'Choose a different model')],
  timeout: [a('retry', 'Retry with a longer timeout', true), a('smaller-quant', 'Choose a smaller model')],
  cancelled: [a('resume', 'Resume', true)],
  other: [a('show-launch-command', 'Show launch command and diagnostics', true), a('retry', 'Retry')],
}

export function recoveryFor(failure: AnyFailure): RecoveryAction[] {
  return MAP[failure]
}
