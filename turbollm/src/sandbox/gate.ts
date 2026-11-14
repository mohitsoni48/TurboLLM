import type { Deps } from '../deps'

/** The one predicate every Python sandbox surface asks before doing anything (GitHub #52).
 *
 *  The sandbox runs model-written Python in Pyodide inside Deno with no network, no env and no write access. It
 *  ships behind `daemon.experimental.sandbox` (Settings → Experimental), off by default, the same two-layer shape
 *  `routines`, `turboLink` and `remoteAccess` established.
 *
 *  **Never on Android.** Deno has no Android build, so the flag reads off there whatever the config says (a
 *  hand-edited or copied config.json must not switch on routes that can only fail).
 *
 *  **Fails closed.** `normalize()` always writes an `experimental` block, so anything arriving here without one is a
 *  half-written or hand-built config, and "off" is the only safe reading.
 *
 *  **Exit path (ADR-280).** On graduation, delete this file, the `sandbox` field in `ExperimentalFeatures`, and the
 *  call sites that import from here. */
export function isSandboxEnabled(d: Deps, platform: NodeJS.Platform = process.platform): boolean {
  if (!sandboxSupported(platform)) return false
  const daemon = d.store.read().daemon as { experimental?: { sandbox?: boolean } } | undefined
  return daemon?.experimental?.sandbox === true
}

/** Whether this platform can run the sandbox at all, flag aside. */
export function sandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'android'
}

/** The typed body a sandbox route answers with while the flag is off. Distinct from a 404 on purpose: a caller must
 *  be able to tell "switched off on this host" from "this build is too old to have the route at all". */
export const SANDBOX_DISABLED = {
  error: {
    code: 'sandbox_disabled',
    message: 'The Python sandbox is switched off on this host (Settings → Experimental).',
  },
} as const

/** The typed body on a platform that cannot run the sandbox. */
export const SANDBOX_UNSUPPORTED = {
  error: {
    code: 'sandbox_unsupported',
    message: 'The Python sandbox needs Windows, macOS or Linux; it is not available on Android.',
  },
} as const
