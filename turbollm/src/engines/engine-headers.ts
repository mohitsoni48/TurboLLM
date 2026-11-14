// The auth headers the daemon sends to a local engine (architecture §6.4). One place decides them, so the in-app SDK's
// bearer rule cannot drift between the call sites that reach an engine.

const TURBOLLM_SDK = 'turbollm-sdk'

/** Sets the auth `headers` a request to a local engine of `engineKind` carries, and returns the same object.
 *
 *  The in-app SDK engine (kind 'turbollm-sdk') takes only its own bearer, minted per app process and handed over in
 *  `TURBOLLM_ANDROID_SDK_TOKEN`, so the token is read on every call and never kept. The client's `authorization` and
 *  `x-api-key` are removed first, which also keeps a TurboLLM API key off the engine port. With no token set, no
 *  bearer is sent and the SDK answers 401: an honest failure, not a guessed credential.
 *
 *  Every other kind keeps today's forwarding untouched: a spawned engine started with `--api-key` relies on it. */
export function engineRequestHeaders(
  engineKind: string,
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): Headers {
  if (engineKind !== TURBOLLM_SDK) return headers
  headers.delete('authorization')
  headers.delete('x-api-key')
  const token = env.TURBOLLM_ANDROID_SDK_TOKEN
  if (token) headers.set('authorization', `Bearer ${token}`)
  return headers
}
