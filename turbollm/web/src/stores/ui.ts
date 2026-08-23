import { create } from 'zustand'

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

// The hardware monitor (ADR-383) is ON by default: the status bar is the point of the
// feature, and a fresh install should show it working. Only an explicit 'false' disables
// it — mirroring the `!== 'false'` idiom SettingsScreen already uses for confirm-delete,
// so garbage or an absent value degrades to the safe default instead of hiding the bar.
const HW_BAR_KEY = 'tllm.hwBar'

function readStoredHwBar(): boolean {
  return localStorage.getItem(HW_BAR_KEY) !== 'false'
}

type UiState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  fontSize: FontSize
  setFontSize: (fontSize: FontSize) => void
  /** Whether the global hardware status bar is shown (ADR-383). Persisted to localStorage;
   *  HardwareBar reads it directly, and the Settings → General toggle writes it. */
  hwBar: boolean
  setHwBar: (v: boolean) => void
  logPanelOpen: boolean
  setLogPanelOpen: (open: boolean) => void
  /** A conversation id another screen wants the Chat screen to open (e.g. the
   *  Launch Expert button in Settings). ChatScreen consumes and clears it. */
  pendingConversationId: string | null
  setPendingConversationId: (id: string | null) => void
}

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
  hwBar: readStoredHwBar(),
  setHwBar: (hwBar) => {
    localStorage.setItem(HW_BAR_KEY, String(hwBar))
    set({ hwBar })
  },
  logPanelOpen: false,
  setLogPanelOpen: (logPanelOpen) => set({ logPanelOpen }),
  pendingConversationId: null,
  setPendingConversationId: (pendingConversationId) => set({ pendingConversationId }),
}))
