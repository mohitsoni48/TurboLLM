import { useSysInfo } from './queries'

/** Does this `SysInfo.os` string name the Android build?
 *
 *  `os` is the daemon's `"<platform>/<arch>"` pair — `"win32/x64"`, `"linux/x64"`,
 *  `"darwin/arm64"`, and under Termux/the Android app `"android/arm64"` (ADR-390:
 *  Node reports `process.platform === 'android'` there, not `'linux'`). Kept as a
 *  pure function so the string rule is unit-testable and lives in ONE place — the
 *  same reason `useIsDesktop` is NOT reused for this: that one is a viewport-width
 *  media query, so a desktop user who narrows their window would trip it, which is
 *  exactly the wrong answer for a platform gate.
 */
export function isAndroidOs(os: string): boolean {
  return os.startsWith('android')
}

/** Is the Code feature (the local coding agent: `/workspace/code`, the Workspace
 *  Chat|Code switcher, and its Settings → Tools & safety sections) available here?
 *
 *  It is cut from the Android release — Code shells out to git and a coding-agent CLI
 *  against a checked-out repo, which a phone has no business doing. This is a platform
 *  gate, not a removal: `screens/code/**` is untouched and desktop behaviour is
 *  identical.
 *
 *  Returns `undefined` while `useSysInfo()` (async, one fetch on first mount) hasn't
 *  answered yet, deliberately rather than guessing — the two possible guesses each
 *  break a different surface, so callers pick per surface:
 *    - Entry points (nav tab, Settings sections) render only on `true`. Guessing
 *      "enabled" there would flash a Code tab onto the Android app and then yank it
 *      away — a visible bug on the platform where the feature is cut — while guessing
 *      "disabled" merely makes it appear a beat late on desktop. Same conservative
 *      "hidden until positively confirmed, never flashes on during a loading state"
 *      convention `routinesEnabled` already uses in App.tsx and ConversationSidebar.
 *    - Routes hold (spinner) on `undefined` instead of redirecting, because a redirect
 *      is destructive: guessing "disabled" for one frame would rewrite a desktop user's
 *      deep link to `/workspace/code/:id` into `/workspace/chat` and lose it.
 *
 *  A FAILED sysinfo fetch resolves to `true`, not `undefined`: the query is
 *  `retry: false`, so an error is terminal, and stranding desktop on a spinner
 *  (or permanently hiding Code) over one bad response is far worse than showing the
 *  feature on a machine we couldn't identify. Android is the app's own WebView talking
 *  to its own in-process daemon — if `/sysinfo` is unreachable there, nothing else works
 *  either.
 */
export function useCodeFeatureEnabled(): boolean | undefined {
  const sysQ = useSysInfo()
  if (sysQ.isError) return true
  const os = sysQ.data?.os
  if (os === undefined) return undefined
  return !isAndroidOs(os)
}
