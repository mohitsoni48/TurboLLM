// context-menu.js — the window's right-click menu.
// Electron-free on purpose (like window-guards.js and window-lifecycle.js), so it can be tested under plain
// `node --test`; main.js builds the Menu from this template on the window's context-menu event.
//
// A browser tab gives every page a right-click menu of its own; an Electron window gives none. Until now a
// right-click in the desktop app did nothing anywhere, text fields included, so paste was Ctrl+V only (issue #302).

const { isWebUrl } = require('./window-guards')

/**
 * The right-click menu for what was clicked, as an Electron Menu template, or [] for no menu.
 * - In a text field: spelling suggestions for a misspelled word, then Undo, Redo, Cut, Copy, Paste, Select All,
 *   each enabled as the field allows (editFlags).
 * - Elsewhere: Copy, when text is selected.
 * - On a web link, anywhere: Copy Link.
 * Edit items use Electron's roles, which act on the focused page and take the OS's own labels and shortcuts.
 * @param {{ isEditable?: boolean, selectionText?: string, linkURL?: string, misspelledWord?: string,
 *   dictionarySuggestions?: string[], editFlags?: Record<string, boolean> }} params Electron's context-menu params
 * @param {{ replaceMisspelling: (word: string) => void, copyLink: (url: string) => void }} actions
 * @returns {Array<object>}
 */
function contextMenuTemplate (params, { replaceMisspelling, copyLink }) {
  const flags = params.editFlags || {}
  const sections = []

  if (params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions || []
    sections.push(suggestions.length > 0
      ? suggestions.map((word) => ({ label: word, click: () => replaceMisspelling(word) }))
      : [{ label: 'No spelling suggestions', enabled: false }])
  }

  if (params.isEditable) {
    sections.push(
      [{ role: 'undo', enabled: Boolean(flags.canUndo) }, { role: 'redo', enabled: Boolean(flags.canRedo) }],
      [
        { role: 'cut', enabled: Boolean(flags.canCut) },
        { role: 'copy', enabled: Boolean(flags.canCopy) },
        { role: 'paste', enabled: Boolean(flags.canPaste) },
      ],
      [{ role: 'selectAll', enabled: Boolean(flags.canSelectAll) }],
    )
  } else if (params.selectionText && params.selectionText.trim() !== '') {
    sections.push([{ role: 'copy' }])
  }

  if (params.linkURL && isWebUrl(params.linkURL)) {
    sections.push([{ label: 'Copy Link', click: () => copyLink(params.linkURL) }])
  }

  return sections.flatMap((items, i) => (i === 0 ? items : [{ type: 'separator' }, ...items]))
}

module.exports = { contextMenuTemplate }
