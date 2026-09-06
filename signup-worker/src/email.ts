/**
 * Confirmation email for a beta application (ADR-403).
 *
 * The copy lives in `templates/confirmation.md` — edit it there, not here. This file
 * only decides which variables and flags that template gets.
 *
 * Sent through Resend. The API key is a Worker secret; the sending domain must be
 * verified in Resend first — see README.md.
 *
 * Deliberately one email, once, on first registration. Re-submitting the form to
 * correct an answer does not trigger another: people fix typos, and a second
 * "welcome" for the same signup reads as a broken system.
 */

import { render } from './templates.ts'
import { confirmation as template } from './templates/index.ts'

const FROM = 'TurboLLM <beta@turbollm.dev>'
const REPLY_TO = 'human@turbollm.dev'

const PLATFORM_LABEL: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
}

export interface Confirmation {
  name: string
  platforms: string[]
  /** Their queue number, or null while the list is still too small to show one. */
  position: number | null
}

export function buildConfirmation({ name, platforms, position }: Confirmation) {
  const flags = [
    ...platforms,
    ...(platforms.some((p) => p === 'windows' || p === 'macos' || p === 'linux') ? ['desktop'] : []),
    // The pill and the numbered opening only appear once there is a number to show.
    ...(position === null ? [] : ['numbered']),
  ]

  const rendered = render(
    template,
    {
      first: name.split(/\s+/)[0] || name,
      platforms: platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(', '),
      position: position === null ? '' : String(position),
      subjectLine:
        position === null ? "You're on the TurboLLM beta list" : `You're #${position} for the TurboLLM beta`,
      opening:
        position === null
          ? "Thanks for applying to the TurboLLM beta. You're on the list."
          : `Thanks for applying to the TurboLLM beta. You're #${position} in the queue.`,
    },
    flags,
  )

  // The pill paragraph is the one thing a flag block cannot express cleanly (it is a
  // single line, not a section), so it is stripped here when there is no number.
  if (position === null) {
    rendered.html = rendered.html.replace(/\s*<p style="margin:0 0 20px"><span[^]*?<\/span><\/p>/, '')
  }
  return rendered
}

/** Resolves to null on success, or a short reason string worth storing. */
export async function sendConfirmation(
  apiKey: string | undefined,
  to: string,
  c: Confirmation,
): Promise<string | null> {
  if (!apiKey) return 'RESEND_API_KEY not configured'

  const { subject, text, html } = buildConfirmation(c)
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, text, html }),
    })
    if (!res.ok) return `resend ${res.status}: ${(await res.text()).slice(0, 200)}`
    return null
  } catch (e) {
    return `resend threw: ${String(e).slice(0, 200)}`
  }
}
