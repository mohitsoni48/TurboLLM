// TerminalView — embeds xterm.js with the @xterm/addon-fit addon.
//
// Rendered full-bleed (no border, no header chrome — CodeSessionScreen's normal header +
// composer shell surrounds it) by CodeSessionScreen for the entire lifetime of any session
// whose codeAgent isn't 'turbollm' (code-types.ts), in place of CodeTranscript. There's no
// separate toggle to open/close it — closing means leaving the session (Ctrl+D).
//
// The PTY output is raw bytes; the browser receives them as UTF-8 text over
// WebSocket and renders them in a real xterm.js terminal emulator. The shell spawned
// server-side already runs `turbollm launch <agent>` as its OWN startup command
// (terminal-routes.ts / pty-session.ts) — nothing is typed into it from here, so the
// launch command itself is never visible, only its output.
//
// xterm.js is fit to its container BEFORE the PTY is even created (see the effect below) —
// the daemon spawns the PTY at that real size from its very first byte. Creating the PTY
// first and resizing afterward (the original version) let interactive TUIs — Claude Code's
// especially, being Ink-based — paint their very first frame at the wrong width, which they
// don't reliably recover from on a later resize: the symptom was overlapping/garbled text and
// keystrokes landing at a corrupted cursor position that never reached the real input line.
//
// The WS listener is managed by `useTerminalConnection` which auto-reconnects.
// Terminal input → WS send → PTY stdin. Terminal resize → WS send `\x1b[8;{rows};{cols}t`.
//
// Colors: xterm can't resolve CSS var()/color-mix() itself (its renderer parses real color
// values, not custom properties) — resolveTerminalTheme() below reads the actual computed
// values of the --term-* tokens (index.css) instead of ever hardcoding a hex literal, so the
// terminal always matches the app's current light/dark theme, live (see the MutationObserver
// in the mount effect).

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTerminalConnection, createTerminalForSession } from '../../lib/terminal-connection'
import { toast } from '../../components/ui/sonner'

/** Reads the app's --term-* design tokens (index.css) as ACTUAL resolved colors — xterm's theme
 *  option needs real values (hex/rgb/color-mix() output as computed by the browser), not the
 *  var()/color-mix() source strings, which its own internal color parser doesn't understand.
 *  Re-run on every theme change (the MutationObserver in the mount effect below), not just once
 *  at mount, so switching light↔dark while a terminal is open updates it live. */
function resolveTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const t = (name: string) => style.getPropertyValue(name).trim()
  return {
    background: t('--term-bg'),
    foreground: t('--term-fg'),
    cursor: t('--term-cursor'),
    selectionBackground: t('--term-selection'),
    black: t('--term-black'),
    red: t('--term-red'),
    green: t('--term-green'),
    yellow: t('--term-yellow'),
    blue: t('--term-blue'),
    magenta: t('--term-magenta'),
    cyan: t('--term-cyan'),
    white: t('--term-white'),
    brightBlack: t('--term-bright-black'),
    brightRed: t('--term-bright-red'),
    brightGreen: t('--term-bright-green'),
    brightYellow: t('--term-bright-yellow'),
    brightBlue: t('--term-bright-blue'),
    brightMagenta: t('--term-bright-magenta'),
    brightCyan: t('--term-bright-cyan'),
    brightWhite: t('--term-bright-white'),
  }
}

interface TerminalViewProps {
  /** The Code session ID this terminal is scoped to. */
  sessionId: string
  /** Called when the terminal view is dismissed (closed). */
  onClose: () => void
}

/** Imperative handle so CodeSessionScreen can drive the running CLI's OWN commands (e.g. `/model`
 *  to switch models, `founder ask: avoid a relaunch`) without needing the terminal itself as a
 *  prop-driven remount target. Deliberately narrow — this is for well-known, safe slash commands
 *  the CLI itself interprets, not a general "type arbitrary text into someone's shell" API. */
export interface TerminalViewHandle {
  /** Sends `command` followed by Enter, exactly as if the user had typed it. */
  /** Type a command into the live TUI and submit it. `confirmAutocomplete` sends a SECOND Enter
   *  shortly after — required by a harness whose slash-command input pops an autocomplete dropdown
   *  that CONSUMES the first Enter to accept the highlighted suggestion. See its caller. */
  sendCommand: (command: string, opts?: { confirmAutocomplete?: boolean }) => void
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { sessionId, onClose },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [terminalId, setTerminalId] = useState<string | null>(null)
  // CodeSessionScreen passes `onClose={() => navigate(...)}` — a NEW function reference every
  // render of that (frequently re-rendering, e.g. the 4s last-usage poll) screen. Reading it via
  // a ref instead of putting it in the mount effect's deps below is what keeps that effect from
  // re-running on every parent render — an earlier version had `onClose` in those deps, which
  // tore the terminal down and reconnected the WebSocket on basically every render. Each
  // teardown's disconnect() closes the socket with no explicit code, which the WebSocket API
  // itself then reports back as close code 1005 — that's what a user actually SEES as "getting a
  // 1005 error" on a terminal that (from the server's own perspective) never had anything wrong
  // with it at all.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const { send, sendResize } = useTerminalConnection(terminalId, {
    onClose: (code, reason) => {
      if (code !== 1000) {
        toast.warning(`Terminal connection closed: ${reason || code}`)
      }
    },
    onError: () => {
      toast.error('Terminal connection error.')
    },
    // PTY output → xterm display. Passed straight through to useTerminalConnection, which
    // attaches this as ws.onmessage synchronously at connect() time — NOT via our own effect
    // keyed on a returned `ws` value (that used to be how this worked, and it raced: the
    // server's scrollback replay can arrive before such an effect gets a chance to run,
    // silently dropping it — see the hook's own doc comment for the full trace of the live
    // "terminal goes blank on switching, fixes itself a few switches later" bug this closes).
    onMessage: (data) => terminalRef.current?.write(data),
  })

  // Lets CodeSessionScreen drive the CLI's own commands (e.g. `/model`, to switch models
  // without a relaunch — the CLI reads its model from env vars at launch and has no live
  // external model-switch API, but it DOES have its own interactive `/model` picker; sending
  // that command opens it exactly as if the user had typed it themselves, no scrollback lost).
  useImperativeHandle(ref, () => ({
    sendCommand: (command: string, opts?: { confirmAutocomplete?: boolean }) => {
      send(`${command}\r`)
      // ── The second Enter (founder-reported; measured in a real PTY, 2026-08-19) ───────────────
      // opencode pops an autocomplete dropdown as soon as a slash command is typed, and its first
      // Enter ACCEPTS the highlighted suggestion instead of submitting the line — so a single `\r`
      // left `/models` sitting in the input and the picker never opened at all. Measured directly:
      //   one Enter  -> picker open FALSE
      //   two Enters -> picker open TRUE
      //
      // Opt-IN per call rather than always-on: where the first Enter already submits, a second
      // would send an empty line to the agent. Only used for a BARE command — typing an argument
      // dismisses the dropdown, which is why claude's `/model claude-<key>` and pi's
      // `/model turbollm/<key>` have always worked with one.
      //
      // The delay lets the TUI process the first keypress and repaint; both in one write can be
      // read as a single paste by some line editors.
      if (opts?.confirmAutocomplete) setTimeout(() => send('\r'), 250)
    },
  }), [send])

  useEffect(() => {
    if (!containerRef.current) return
    setTerminalId(null)

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", menlo, monospace',
      theme: resolveTerminalTheme(),
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    terminalRef.current = term

    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    // Keep the terminal's colors in sync with the app's own light/dark toggle (stores/ui.ts
    // flips a `dark` class on <html>; --term-* tokens in index.css are pure var()/color-mix()
    // compositions of the SAME tokens that already flip per theme). xterm can't resolve CSS
    // custom properties itself — its renderer parses real color values, not var() strings —
    // so this re-reads getComputedStyle and pushes a fresh resolved theme into the LIVE
    // terminal instance whenever the class actually changes, rather than only at mount.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = resolveTerminalTheme()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    term.onResize(({ cols, rows }) => {
      // A real PTY resize is an ioctl-level size change (node-pty's resize()), not
      // something achieved by writing an escape sequence into the shell's stdin — an
      // earlier version tried exactly that (`\x1b[8;rows;colst` sent via `send`, which
      // writes to the PTY's INPUT stream) and it corrupted the display: the shell
      // couldn't parse it as real input and echoed it back as literal garbage text.
      // sendResize goes over a separate binary WS frame the daemon routes to the
      // actual resize() call instead. A no-op before the WS connects (send/sendResize
      // guard on the socket being open) — harmless for the very first, pre-creation fit.
      sendResize(cols, rows)
    })

    term.onData((data) => {
      send(data)
    })

    term.focus()

    let cancelled = false
    let created = false
    // ResizeObserver, not a single one-shot requestAnimationFrame: the container's flex layout
    // doesn't necessarily reach its FINAL size on the very next paint — it can keep settling for
    // a frame or two more as siblings (TerminalToolbar below, ADR-284) finish their own layout,
    // web fonts finish loading, etc. A one-shot fit() that ran before that settled left the
    // terminal visibly smaller than its actual available space (a real gap + the toolbar reading
    // as a floating disconnected box below it, not the terminal's real bottom edge). A
    // ResizeObserver fires once immediately on `observe()` with the CURRENT box size, and again
    // on every subsequent real size change — so this single callback both handles the original
    // "wait for real layout before creating the PTY" job AND keeps the terminal correctly sized
    // for the rest of its life, replacing the old window-resize-only listener (which never
    // caught anything except the OS window itself changing size).
    const ro = new ResizeObserver(() => {
      if (cancelled) return
      try { fitAddon.fit() } catch { /* best-effort — container may be mid-teardown */ }
      if (created) return // later calls: just re-fit (term.onResize above sends the new size)
      created = true
      // fit() above already applied the REAL size synchronously, so term.cols/term.rows are
      // accurate by the time this fires — the whole point of creating the PTY here rather than
      // resizing it after the fact (see module header).
      void createTerminalForSession(sessionId, term.cols, term.rows).then((result) => {
        if (cancelled) return
        if (result && 'terminalId' in result) {
          setTerminalId(result.terminalId)
        } else {
          toast.error(result ? `Could not create terminal session: ${result.error}` : 'Could not create terminal session.')
          onCloseRef.current()
        }
      })
    })
    ro.observe(containerRef.current)

    return () => {
      cancelled = true
      ro.disconnect()
      themeObserver.disconnect()
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, send, sendResize])

  // Keyboard shortcut: Ctrl+D to close terminal view. Also reads onCloseRef rather than
  // depending on onClose directly, so this listener isn't torn down/re-added every render
  // either (harmless on its own, but there's no reason for it to churn any more than the
  // main effect above does).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Horizontal padding matches TerminalToolbar's own `px-3 md:px-8` (founder, 2026-07-29: the CLI
  // output sat flush against the window edge while everything below it was inset).
  //
  // It goes on a WRAPPER, not on the element xterm mounts into, and that distinction is load-
  // bearing rather than cosmetic. FitAddon derives the column count from
  // `getComputedStyle(terminal.element.parentElement).width`, subtracting only the padding of the
  // `.xterm` element ITSELF. Under Tailwind's `box-sizing: border-box` that computed width is the
  // BORDER box — measured in the live app: an 864px container with 32px gutters still reports
  // `width: 864px`, not 800px. Padding the mount element directly therefore sizes the grid to
  // space it doesn't have (~8 columns too many here) and the right edge is clipped, silently, only
  // at md+ where the gutter is wide. With the padding one level out, the mount element's own box
  // IS the available space and the arithmetic is right by construction. The ResizeObserver above
  // watches that inner element, so crossing the `md` breakpoint re-fits like any other resize.
  //
  // Vertical stays 0 so the terminal still runs edge to edge into the toolbar's own border, and
  // `--term-bg` sits on the wrapper so the gutter reads as part of the terminal, not a seam.
  //
  // `tllm-terminal` is the hook for the one place the app-wide scrollbar rule is overridden
  // (index.css) — a TUI repaints the whole pane itself, so a scrollbar track on top of it reads as
  // app chrome intruding. Wheel scrolling is unaffected; see that rule for the full reasoning.
  return (
    <div className="tllm-terminal flex min-h-0 flex-1 flex-col px-3 md:px-8" style={{ background: 'var(--term-bg)' }}>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  )
})
