/**
 * Build-invite email (ADR-404) — "your build is ready, here is the link".
 *
 * The copy lives in `templates/invite.md` — edit it there, not here.
 *
 * Separate from the confirmation in `email.ts`: that one acknowledges an
 * application, this one hands over a build. Sent by POST /admin/invite, which
 * stamps `invited_at` so nobody is invited to the same track twice.
 */

import { render } from './templates.ts'
import { invite as template } from './templates/index.ts'

const FROM = 'TurboLLM <beta@turbollm.dev>'
const REPLY_TO = 'human@turbollm.dev'

const LABEL: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
}

export interface Invite {
  name: string
  platform: string
  url: string
}

export function buildInvite({ name, platform, url }: Invite) {
  const flags = [platform, platform === 'android' || platform === 'ios' ? 'mobile' : 'desktop']
  return render(
    template,
    { first: name.split(/\s+/)[0] || name, platformLabel: LABEL[platform] ?? platform, url },
    flags,
  )
}

/** Resolves to null on success, or a short reason worth reporting. */
export async function sendInvite(apiKey: string | undefined, to: string, i: Invite): Promise<string | null> {
  if (!apiKey) return 'RESEND_API_KEY not configured'
  const { subject, text, html } = buildInvite(i)
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
