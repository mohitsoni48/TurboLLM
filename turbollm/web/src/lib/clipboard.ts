/** Copy `text` to the clipboard of the machine this browser runs on.
 *
 *  `navigator.clipboard` only exists in a secure context (HTTPS or localhost). Opened over the
 *  LAN as `http://192.168.x.x:6996`, it is `undefined`, so the legacy selection-based copy is
 *  the only way left. Rejects when neither path works, so callers can tell the user. */
export async function copyToClipboard(text: string): Promise<void> {
  if (await copyWithClipboardApi(text)) return
  if (!copyWithSelection(text)) throw new Error('Clipboard is not available in this browser')
}

async function copyWithClipboardApi(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Permission denied or document not focused: the selection path may still succeed.
    return false
  }
}

function copyWithSelection(text: string): boolean {
  const previouslyFocused = document.activeElement
  const field = createOffscreenField(text)
  // Inside the focused element's parent, not <body>: a modal dialog's focus trap would pull
  // focus back out of a field mounted outside it and drop the selection.
  const host = previouslyFocused?.parentElement ?? document.body
  host.appendChild(field)
  try {
    field.focus()
    field.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    host.removeChild(field)
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
  }
}

function createOffscreenField(text: string): HTMLTextAreaElement {
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.setAttribute('aria-hidden', 'true')
  field.style.position = 'fixed'
  field.style.top = '0'
  field.style.left = '-9999px'
  field.style.opacity = '0'
  return field
}
