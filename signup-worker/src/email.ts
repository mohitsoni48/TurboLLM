/**
 * Confirmation email for a beta application (ADR-403).
 *
 * Sent through Resend. The API key is a Worker secret (`wrangler secret put
 * RESEND_API_KEY`) and the sending domain has to be verified in Resend first —
 * see README.md.
 *
 * Deliberately one email, once, on first registration. Re-submitting the form to
 * correct an answer does not trigger another: people fix typos, and a second
 * "welcome" for the same signup reads as a broken system.
 */

const FROM = 'TurboLLM <beta@turbollm.dev>'
const REPLY_TO = 'human@turbollm.dev'

const PLATFORM_LABEL: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface Confirmation {
  name: string
  platforms: string[]
  /** Their queue number, or null while the list is still too small to show one. */
  position: number | null
}

export function buildConfirmation({ name, platforms, position }: Confirmation): {
  subject: string
  text: string
  html: string
} {
  const first = name.split(/\s+/)[0] || name
  const picked = platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(', ')
  const wantsDesktop = platforms.some((p) => p === 'windows' || p === 'macos' || p === 'linux')
  const wantsAndroid = platforms.includes('android')

  const subject = position === null ? "You're on the TurboLLM beta list" : `You're #${position} for the TurboLLM beta`
  const opening =
    position === null
      ? "Thanks for applying to the TurboLLM beta. You're on the list."
      : `Thanks for applying to the TurboLLM beta. You're #${position} in the queue.`

  const notes: string[] = []
  if (wantsDesktop) {
    notes.push(
      'The desktop builds are not code-signed yet, so Windows will show a SmartScreen warning and macOS will ask you to right-click and choose Open the first time. That is expected, not a sign something is wrong.',
    )
  }
  if (wantsAndroid) {
    notes.push(
      'Android testing runs through the Play Store, so the invite has to go to the Google account your phone signs in with. If that is a different address to this one, just reply and tell me which to use.',
    )
  }

  const text = [
    `Hi ${first},`,
    '',
    opening,
    '',
    `You said you can test on: ${picked}.`,
    '',
    'When a build is ready for one of those, it comes to this address with instructions. That is the only thing you will get. No newsletter, no drip campaign.',
    ...(notes.length ? ['', ...notes] : []),
    '',
    'Want your details removed, at any point? Reply to this email and they are gone.',
    '',
    "If you didn't apply for this, someone typed your address by mistake. Reply and I'll delete it.",
    '',
    'Mohit',
    'turbollm.dev',
  ].join('\n')

  const html = `<!doctype html>
<html><body style="margin:0;background:#faf9f7;padding:28px 16px;font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a18">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto">
    <tr><td style="background:#ffffff;border:1px solid #e7e4de;border-radius:14px;padding:28px">
      <p style="margin:0 0 18px">Hi ${esc(first)},</p>
      <p style="margin:0 0 18px">${esc(opening)}</p>
      ${
        position === null
          ? ''
          : `<p style="margin:0 0 20px"><span style="display:inline-block;background:#c96442;color:#ffffff;font-size:22px;font-weight:700;padding:8px 18px;border-radius:999px">#${position}</span></p>`
      }
      <p style="margin:0 0 18px;color:#6b6a66">You said you can test on: <strong style="color:#1a1a18">${esc(picked)}</strong>.</p>
      <p style="margin:0 0 18px">When a build is ready for one of those, it comes to this address with instructions. That is the only thing you will get. No newsletter, no drip campaign.</p>
      ${notes.map((n) => `<p style="margin:0 0 18px;color:#6b6a66;font-size:15px">${esc(n)}</p>`).join('')}
      <p style="margin:0 0 18px;color:#6b6a66;font-size:15px">Want your details removed, at any point? Reply to this email and they are gone.</p>
      <p style="margin:0 0 22px;color:#9c9a94;font-size:14px">If you didn't apply for this, someone typed your address by mistake. Reply and I'll delete it.</p>
      <p style="margin:0">Mohit<br /><a href="https://turbollm.dev" style="color:#c96442;text-decoration:none">turbollm.dev</a></p>
    </td></tr>
  </table>
</body></html>`

  return { subject, text, html }
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
