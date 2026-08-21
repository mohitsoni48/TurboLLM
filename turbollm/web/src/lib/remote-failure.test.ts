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
