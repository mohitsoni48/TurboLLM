import { create } from 'zustand'
import { ApiError } from '../lib/api'
import { setSelectedRemoteModel } from '../lib/link-api'
import { toast } from '../components/ui/sonner'

export type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'tllm.theme'

function readStoredTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

/** Resolve the effective light/dark mode for a theme value, honoring system. */
export function resolveDark(theme: Theme): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Apply or remove the `.dark` class on <html>. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', resolveDark(theme))
}

// A percentage, e.g. 85–130 in 5% steps (100 = default/1×) — driven by a Slider
// in Settings (same component as the VRAM headroom slider), not a fixed enum.
export type FontSize = number

const FONT_SIZE_KEY = 'tllm.fontSize'
const FONT_SIZE_DEFAULT: FontSize = 100
const FONT_SIZE_MIN: FontSize = 85
const FONT_SIZE_MAX: FontSize = 130

function readStoredFontSize(): FontSize {
  const v = Number(localStorage.getItem(FONT_SIZE_KEY))
  return Number.isFinite(v) && v >= FONT_SIZE_MIN && v <= FONT_SIZE_MAX ? v : FONT_SIZE_DEFAULT
}

/** Set the `--font-scale` custom property on <html> (index.css reads this via
 *  `calc(14px * var(--font-scale, 1))`), converting the stored percentage to a
 *  multiplier — so every rem/em-relative size in the app scales together, not
 *  just literal px bumps in individual components. */
export function applyFontSize(fontSize: FontSize): void {
  document.documentElement.style.setProperty('--font-scale', String(fontSize / 100))
}

type UiState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  fontSize: FontSize
  setFontSize: (fontSize: FontSize) => void
  logPanelOpen: boolean
  setLogPanelOpen: (open: boolean) => void
  /** A conversation id another screen wants the Chat screen to open (e.g. the
   *  Launch Expert button in Settings). ChatScreen consumes and clears it. */
  pendingConversationId: string | null
  setPendingConversationId: (id: string | null) => void
  /** Turbo Link (ADR-376): the qualified `<machine>/<model>` id chat is pointed at, or
   *  null for "this machine's loaded model".
   *
   *  Store state rather than ChatScreen state, because every screen is lazily routed and
   *  therefore UNMOUNTS on navigation: held in `useState` the pick silently reverted to
   *  the local model the moment the user visited Models, Code or Settings and came back —
   *  with the picker showing the local model as if nothing had been chosen. A local
   *  selection is an engine load the daemon remembers on its own; a remote one is pure
   *  routing state nothing else persists, so it has to live somewhere that outlives the
   *  screen.
   *
   *  The DAEMON owns the real value (ADR-382, config `selectedRemoteModel`); this is a
   *  mirror of it. It has to be daemon-side because the browser is not the only surface
   *  that reads it — `turbollm launch <cli>` is a separate process, and while this lived
   *  only here it auto-loaded a LOCAL model while the UI showed a linked machine selected.
   *  localStorage stays as a first-paint cache so the picker isn't blank for one poll.
   *
   *  Staleness is safe by construction: every consumer resolves the id through
   *  `findRemoteChoice`, which yields nothing unless that link is online AND still
   *  advertises that model — an id whose machine went away is simply ignored. */
  remoteModelId: string | null
  /** Optimistic: sets locally, then persists to the daemon. */
  setRemoteModelId: (id: string | null) => void
  /** Adopt the daemon's value (status poll). Ignored while a write of ours is in flight, so
   *  a poll that raced a fresh pick cannot snap the picker back to the old machine. */
  syncRemoteModelId: (id: string | null) => void
}

const REMOTE_MODEL_KEY = 'tllm.remoteModelId'

function readStoredRemoteModelId(): string | null {
  return localStorage.getItem(REMOTE_MODEL_KEY) || null
}

function cacheRemoteModelId(id: string | null): void {
  if (id) localStorage.setItem(REMOTE_MODEL_KEY, id)
  else localStorage.removeItem(REMOTE_MODEL_KEY)
}

/** How many of our own writes are in flight. A status poll that lands while one is means the
 *  daemon has not seen the new pick yet, and adopting its answer would visibly snap the picker
 *  back to the previous machine. */
let pendingWrites = 0

export const useUiStore = create<UiState>((set) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme)
    applyTheme(theme)
    set({ theme })
  },
  fontSize: readStoredFontSize(),
  setFontSize: (fontSize) => {
    localStorage.setItem(FONT_SIZE_KEY, String(fontSize))
    applyFontSize(fontSize)
    set({ fontSize })
  },
  logPanelOpen: false,
  setLogPanelOpen: (logPanelOpen) => set({ logPanelOpen }),
  pendingConversationId: null,
  setPendingConversationId: (pendingConversationId) => set({ pendingConversationId }),
  remoteModelId: readStoredRemoteModelId(),
  setRemoteModelId: (remoteModelId) => {
    cacheRemoteModelId(remoteModelId)
    set({ remoteModelId })
    // Persist to the daemon — the surface that actually has to agree with this is the CLI,
    // not this tab. Counted so an in-flight write wins over any status poll that lands
    // mid-flight (see syncRemoteModelId).
    pendingWrites++
    void setSelectedRemoteModel(remoteModelId)
      .catch((e) => {
        // A pick the daemon refused (the link went offline between listing and clicking) must
        // not sit in the UI looking selected — every later turn would 503. Revert and say why.
        cacheRemoteModelId(null)
        set({ remoteModelId: null })
        toast.error(e instanceof ApiError ? e.message : 'Could not switch to that machine.')
      })
      .finally(() => { pendingWrites-- })
  },
  syncRemoteModelId: (remoteModelId) => {
    if (pendingWrites > 0) return
    if (useUiStore.getState().remoteModelId === remoteModelId) return
    cacheRemoteModelId(remoteModelId)
    set({ remoteModelId })
  },
}))
