import { describe, it, expect } from 'vitest'
import { ApiError } from './api'
import { describeRemoteFailure } from './remote-failure'

/** The typed errors the peer-side admin proxy relays, built the way link-api.ts builds
 *  them. `capability` is the field the host names on a 403. */
function apiErr(code: string, status: number, capability?: string): ApiError {
  const e = new ApiError(code, 'server-composed message', status)
  if (capability) e.capability = capability
  return e
}

describe('describeRemoteFailure', () => {
  // The whole reason task 5b preserved these distinctions: flattening them is what makes a
  // user debug the wrong problem. Each of these must be a DIFFERENT sentence.
  it('gives every relayed code a distinct sentence', () => {
    const codes = [
      'forbidden',
      'revoked',
      'incompatible',
      'unavailable',
      'host_busy',
      'model_not_loaded',
      'comfyui_busy',
      'no_such_model',
      'remote_not_found',
      'not_found',
      'rate_limited',
    ]
    const seen = new Set(codes.map((c) => describeRemoteFailure(apiErr(c, 503), 'workstation').message))
    expect(seen.size).toBe(codes.length)
  })

  it('names both the capability and the machine on a 403 that carries one', () => {
    const f = describeRemoteFailure(apiErr('forbidden', 403, 'models:load'), 'workstation')
    expect(f.message).toMatch(/models:load/)
    expect(f.message).toMatch(/workstation/)
  })

  it('says the host is busy — not that a permission is missing — for host_busy', () => {
    const f = describeRemoteFailure(apiErr('host_busy', 503), 'workstation')
    expect(f.message).toMatch(/workstation/)
    expect(f.message).not.toMatch(/permission|grant/i)
    // Waiting is the remedy, so the UI may offer a retry.
    expect(f.retryable).toBe(true)
  })

  it('distinguishes "no model loaded there" from "that machine is offline"', () => {
    const notLoaded = describeRemoteFailure(apiErr('model_not_loaded', 409), 'workstation')
    const offline = describeRemoteFailure(apiErr('unavailable', 503), 'workstation')
    expect(notLoaded.message).not.toBe(offline.message)
    expect(offline.message).toMatch(/workstation/)
    // An offline host is not fixed by retrying the same click.
    expect(offline.retryable).toBe(false)
  })

  it('points a revoked link at relinking rather than at a permission', () => {
    const f = describeRemoteFailure(apiErr('revoked', 403), 'workstation')
    expect(f.message).toMatch(/link/i)
    expect(f.retryable).toBe(false)
  })

  it('never renders the host-authored message, which can carry a host path', () => {
    // link-api composes `message` from the response; the SERVER composes that locally and
    // never relays the host's own. This helper must not start echoing it back either — it
    // works from `code` alone, so a hostile host cannot get prose onto this screen.
    const e = new ApiError('host_busy', "ENOENT open 'D:\\models\\qwen3.gguf'", 503)
    const f = describeRemoteFailure(e, 'workstation')
    expect(f.message).not.toMatch(/ENOENT/)
    expect(f.message).not.toMatch(/D:/)
  })

  it('falls back to a machine-named sentence for an unknown code, never an empty string', () => {
    const f = describeRemoteFailure(apiErr('something_new', 500), 'workstation')
    expect(f.message).toMatch(/workstation/)
    expect(f.message.length).toBeGreaterThan(0)
  })

  it('handles a non-ApiError throw without producing "undefined"', () => {
    const f = describeRemoteFailure(new TypeError('network down'), 'workstation')
    expect(f.message).toMatch(/workstation/)
    expect(f.message).not.toMatch(/undefined/)
  })
})

// ── Download-specific host codes (final review M-7 and I-3) ──────────────────────────────
//
// All three used to reach the `default` branch, which says "try again" — and retrying
// cannot help with any of them. `hf_unauthorized` was worse than that: the peer proxy
// relabelled the host's 401 as "your link was revoked", sending the user to re-mint a
// token that was never the problem.
describe('describeRemoteFailure — the host could not fetch that file', () => {
  it('hf_unauthorized points at the HOST’s Hugging Face token, not at the link', () => {
    const f = describeRemoteFailure(apiErr('hf_unauthorized', 403), 'workstation')
    expect(f.message).toMatch(/Hugging Face/i)
    expect(f.message).toMatch(/workstation/)
    expect(f.message).not.toMatch(/revoke/i)
    expect(f.message).not.toMatch(/paste a new link/i)
    expect(f.retryable).toBe(false)
  })

  it('hf_gated says the repo is gated, and does not offer a retry', () => {
    const f = describeRemoteFailure(apiErr('hf_gated', 403), 'workstation')
    expect(f.message).toMatch(/gated/i)
    expect(f.retryable).toBe(false)
  })

  it('no_model_dir names the setting to fix, on the machine that has to fix it', () => {
    const f = describeRemoteFailure(apiErr('no_model_dir', 409), 'workstation')
    expect(f.message).toMatch(/model folder/i)
    expect(f.message).toMatch(/workstation/)
    expect(f.retryable).toBe(false)
  })

  it('none of them falls through to the generic "try again"', () => {
    for (const code of ['hf_unauthorized', 'hf_gated', 'no_model_dir', 'no_such_download']) {
      const f = describeRemoteFailure(apiErr(code, 400), 'workstation')
      expect(f.message, code).not.toMatch(/Something went wrong/i)
      expect(f.retryable, code).toBe(false)
    }
  })
})
