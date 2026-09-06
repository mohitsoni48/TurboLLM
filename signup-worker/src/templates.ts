/**
 * Tiny template renderer for the outgoing emails (ADR-404).
 *
 * The copy lives in `src/templates/*.md`, imported as text modules (see the `rules`
 * block in wrangler.toml). One file per email is the whole point: the plain-text and
 * HTML versions are RENDERED from the same source rather than maintained as two
 * copies that quietly drift apart.
 *
 * The dialect is deliberately tiny — it only has to serve a handful of emails:
 *
 *   ---
 *   subject: Your TurboLLM {{platformLabel}} build is ready
 *   ---
 *   Hi {{first}},                    ← paragraphs, blank-line separated
 *   **bold** and [links](https://…)  ← inline
 *   > a muted, smaller paragraph     ← blockquote
 *   {{cta:Get the build|{{url}}}}    ← button in HTML, bare URL in text
 *   {{pill:#42}}                     ← accent pill in HTML, omitted from text
 *   :::android … :::                 ← kept only when that flag is active
 *
 * Anything richer belongs in a real templating library, and a marketing email that
 * needs one belongs somewhere other than a Worker.
 */

const ACCENT = '#c96442'

export interface Rendered {
  subject: string
  text: string
  html: string
}

const escHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `{{var}}`, applied repeatedly so a value may itself contain a placeholder. */
function substitute(src: string, vars: Record<string, string>): string {
  let out = src
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (m, k) => (k in vars ? vars[k] : m))
    if (next === out) break
    out = next
  }
  return out
}

/** `:::flag … :::` — kept when the flag is active, dropped whole when it is not. */
function applyFlags(src: string, flags: string[]): string {
  return src.replace(/^:::([a-zA-Z0-9_-]+)\n([\s\S]*?)^:::\s*$/gm, (_m, flag: string, body: string) =>
    flags.includes(flag) ? body.trim() + '\n' : '',
  )
}

/** Inline markdown → plain text (markers removed, links become "text (url)"). */
function inlineText(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
      // "turbollm.dev (https://turbollm.dev)" is noise; print the URL once.
      url.replace(/^https?:\/\//, '').replace(/\/$/, '') === label ? url : `${label} (${url})`,
    )
    .replace(/\*\*([^*]+)\*\*/g, '$1')
}

/** Inline markdown → HTML. */
function inlineHtml(s: string): string {
  return escHtml(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" style="color:${ACCENT};text-decoration:none">$1</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

export function render(source: string, vars: Record<string, string>, flags: string[] = []): Rendered {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(source)
  if (!fm) throw new Error('template is missing its --- front matter ---')
  const subject = substitute((/^subject:\s*(.+)$/m.exec(fm[1])?.[1] ?? '').trim(), vars)
  if (!subject) throw new Error('template front matter has no subject')

  const body = substitute(applyFlags(source.slice(fm[0].length), flags), vars).trim()

  const textParts: string[] = []
  const htmlParts: string[] = []

  for (const raw of body.split(/\n{2,}/)) {
    const block = raw.trim()
    if (!block) continue

    const cta = /^\{\{cta:([^|]+)\|([^}]+)\}\}$/.exec(block)
    if (cta) {
      // Text gets the bare URL: a "click here" with no visible address is exactly
      // what a phishing filter — and a wary human — dislikes.
      textParts.push(cta[2].trim())
      htmlParts.push(
        `<p style="margin:0 0 24px"><a href="${escHtml(cta[2].trim())}" style="display:inline-block;background:${ACCENT};color:#ffffff;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:999px">${escHtml(cta[1].trim())}</a></p>`,
      )
      continue
    }

    const pill = /^\{\{pill:(.+)\}\}$/.exec(block)
    if (pill) {
      htmlParts.push(
        `<p style="margin:0 0 20px"><span style="display:inline-block;background:${ACCENT};color:#ffffff;font-size:22px;font-weight:700;padding:8px 18px;border-radius:999px">${escHtml(pill[1].trim())}</span></p>`,
      )
      continue
    }

    if (block.startsWith('> ')) {
      const inner = block.replace(/^> ?/gm, '')
      textParts.push(inlineText(inner))
      htmlParts.push(`<p style="margin:0 0 18px;color:#6b6a66;font-size:15px">${inlineHtml(inner)}</p>`)
      continue
    }

    textParts.push(inlineText(block))
    htmlParts.push(`<p style="margin:0 0 18px">${inlineHtml(block).replace(/\n/g, '<br />')}</p>`)
  }

  const html = `<!doctype html>
<html><body style="margin:0;background:#faf9f7;padding:28px 16px;font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a18">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto">
    <tr><td style="background:#ffffff;border:1px solid #e7e4de;border-radius:14px;padding:28px">
${htmlParts.map((p) => '      ' + p).join('\n')}
    </td></tr>
  </table>
</body></html>`

  return { subject, text: textParts.join('\n\n'), html }
}
