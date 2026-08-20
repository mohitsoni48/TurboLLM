import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Loader2, Rocket, Sparkles, Terminal } from 'lucide-react'
import { createConversation } from '../../../lib/chat-api'
import { availableCodeAgents, type CodeAgent } from '../../../lib/code-types'
import { useAgentAvailability, useSettings, useStatus } from '../../../lib/queries'
import { useOnboardingMachine } from '../../../lib/onboarding/useOnboardingMachine'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step 6 — Payoff (spec 25 §4, last step). Creates a REAL conversation
 *  (Casual/Enthusiast) — proving generation actually works — or, for
 *  Developer, saves the picked coding-agent default and hands off to the
 *  real Code launchpad (`CodeHomeScreen`, `/workspace/code`) where the user
 *  picks their OWN repo, model, and task. Either way: completes onboarding
 *  and navigates straight there, one click.
 *
 *  Developer used to auto-create a Code session directly from here with a
 *  hardcoded `repoRoot: '.'` and a canned task string, never asking which
 *  repo the user actually meant — reported directly, live: "which repo?
 *  which path? ... I told you to open code welcome screen that is already
 *  built where user can select repo." `repoRoot: '.'` resolves against the
 *  DAEMON's own working directory, not anything the user chose — on a real
 *  install that's `~/.turbollm` or wherever the process launched from, never
 *  a real code repo. `CodeHomeScreen` already exists, is fully built (repo
 *  picker via `FsBrowser`, model picker, agent mode, task composer) and is
 *  exactly what a first-time Developer should land on. This step's job is
 *  now only to set them up for it (agent default) and get them there.
 *
 *  Used to be two steps: this one created the conversation/session and only
 *  ADVANCED into a separate "You're set up" step, which then had to
 *  complete onboarding and navigate for real. That split existed to dodge a
 *  race with `OnboardingScreenInner`'s "already done" redirect effect — but
 *  that effect is now scoped to fire only once, on the query's FIRST
 *  settle (see its own comment), so it can never fire again once the user
 *  has manually navigated this deep into the wizard. The race is gone, and
 *  the split just meant clicking "Start chatting" landed on ANOTHER whole
 *  screen instead of actually chatting — reported directly: "abrupt,
 *  combine them." Merged back into one step, one click. */
export default function PayoffStep({ ctx }: StepComponentProps) {
  const navigate = useNavigate()
  const { completeOnboarding } = useOnboardingMachine()
  const statusQ = useStatus()
  const { query: settingsQ, save: saveSettings } = useSettings()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Synchronous guard: `starting` is React state, so its re-render (and the
  // button's disabled prop) does not take effect until after the next
  // render commits. A second click fired before that commit bypasses it.
  // Found by adversarial QA: two synchronous clicks created two real
  // conversations, ~25ms apart, with one silently orphaned.
  const startedRef = useRef(false)

  const isDeveloper = ctx.profile === 'developer'

  // Same gating CodeAgentSection uses (ADR-239: don't offer an agent that isn't confirmed
  // working on this install). Defaults to 'claude' per the founder's explicit ask — a first
  // Code session should show off the real CLI, not the built-in chat UI — falling back to
  // the built-in only when this install genuinely has no terminal backend to run it in.
  const terminalAvailable = statusQ.data?.terminalAvailable !== false
  const agents = availableCodeAgents(terminalAvailable)
  // Unknown (still loading, or an older daemon with no such endpoint) counts as installed, so a
  // missing answer never locks the picker — same reading `terminalAvailable` uses.
  const agentAvailabilityQ = useAgentAvailability()
  const isInstalled = (id: string) =>
    id === 'turbollm' || (agentAvailabilityQ.data?.agents.find((a) => a.id === id)?.installed ?? true)
  const [selectedAgent, setSelectedAgentState] = useState<CodeAgent>('claude')
  // Seed from the server's ACTUAL default once it's known, unless the user has already
  // touched the picker — otherwise a returning user with a real preference (e.g.
  // 'turbollm') sees the picker default to 'claude' and then has that preference silently
  // overwritten below, exactly the clobber this file's own "never clobbers a returning
  // user's own preference" comment claimed didn't happen. Found by an Opus release-review
  // pass: `selectedAgent` started hardcoded 'claude', so the "only writes when changing"
  // check below was always comparing against the wrong baseline. A genuinely fresh install
  // (no `defaultAgent` recorded yet) still lands on 'claude', matching the founder's ask.
  const userPickedAgentRef = useRef(false)
  useEffect(() => {
    if (userPickedAgentRef.current) return
    const serverDefault = settingsQ.data?.code?.defaultAgent as CodeAgent | undefined
    if (serverDefault) setSelectedAgentState(serverDefault)
  }, [settingsQ.data])
  const setSelectedAgent = (agent: CodeAgent) => {
    userPickedAgentRef.current = true
    setSelectedAgentState(agent)
  }
  const effectiveAgent = agents.some((a) => a.id === selectedAgent) ? selectedAgent : (agents[0]?.id ?? 'turbollm')

  const start = async () => {
    if (startedRef.current) return
    startedRef.current = true
    setStarting(true)
    setError(null)
    try {
      let dest: string
      if (isDeveloper) {
        // The agent is a session-creation-time snapshot of the SERVER's default
        // (config.ts's code.defaultAgent, code-routes.ts) — there is no per-session
        // override in the create call itself, so picking a different agent here means
        // setting that default first and letting the session snapshot pick it up, same
        // as Settings' own CodeAgentSection does. Only writes it when it's actually
        // changing, so this never clobbers a returning user's own preference for no reason.
        if (settingsQ.data && settingsQ.data.code?.defaultAgent !== effectiveAgent) {
          await saveSettings.mutateAsync({ code: { defaultAgent: effectiveAgent } })
        }
        // No session created here — CodeHomeScreen is the real repo/model/task picker
        // (FsBrowser folder picker, model picker, agent mode, composer). Creating one
        // ourselves meant guessing a repo path and a task nobody asked for.
        dest = '/workspace/code'
      } else {
        const conv = await createConversation({ title: 'Welcome to TurboLLM' })
        dest = `/workspace/chat/${conv.id}`
      }
      await completeOnboarding()
      navigate(dest)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start it — try again.')
      setStarting(false)
      startedRef.current = false
    }
  }

  // Shared with `start`'s own double-click guard in spirit (see its comment) but kept as
  // a separate ref: these two buttons are mutually exclusive with each other and with the
  // primary action, not synchronized to `starting`/`startedRef` above.
  const secondaryStartedRef = useRef(false)

  const exploreModels = async () => {
    if (secondaryStartedRef.current) return
    secondaryStartedRef.current = true
    try {
      await completeOnboarding()
      navigate('/models')
    } catch (e) {
      // Found by an Opus release-review pass: this and `visitSite` below had no error
      // handling at all — a rejected completeOnboarding() (daemon hiccup, auth expiry)
      // was an unhandled promise rejection and a button that silently did nothing.
      setError(e instanceof Error ? e.message : 'Could not finish onboarding — try again.')
      secondaryStartedRef.current = false
    }
  }

  const visitSite = () => {
    if (secondaryStartedRef.current) return
    secondaryStartedRef.current = true
    // Opens SYNCHRONOUSLY, inside the click handler's own call stack — `window.open` only
    // survives the popup blocker within the user-gesture window, which an `await` before
    // it consumes. Found by an Opus release-review pass: this regressed working behavior
    // from the deleted DoneStep, which called `window.open` synchronously in its own
    // onClick — after the merge, `completeOnboarding()`'s real network round trip ran
    // first, so the popup blocker silently ate the tab. `noopener` also drops the
    // reverse-tabnabbing handle the opened page would otherwise get back into this app.
    window.open('https://turbollm.dev', '_blank', 'noopener,noreferrer')
    completeOnboarding()
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not finish onboarding — try again.'))
      .finally(() => { secondaryStartedRef.current = false })
  }

  return (
    <div className="space-y-6 text-center">
      <div className="flex items-center justify-center gap-3 mb-2">
        <Sparkles size={28} className="text-accent" />
        <h3 className="text-xl font-semibold text-ink">You're set up</h3>
      </div>
      <p className="text-sm text-muted mb-6">
        {isDeveloper
          ? "Your model is ready. Head to Code to pick a repository and start your first task."
          : 'Your model is ready. Start a real conversation to see it in action.'}
      </p>

      {isDeveloper && agents.length > 1 && (
        <div className="flex items-center justify-center gap-2 mb-2">
          <label htmlFor="payoff-agent" className="text-xs text-muted">Coding agent</label>
          <select
            id="payoff-agent"
            value={effectiveAgent}
            onChange={(e) => setSelectedAgent(e.target.value as CodeAgent)}
            disabled={starting}
            className="rounded-md border border-border bg-panel px-2 py-1.5 text-sm text-ink outline-none focus:border-accent transition-colors disabled:opacity-40"
          >
            {agents.map((a) => {
              // An uninstalled harness stays VISIBLE but unselectable, so onboarding shows what
              // TurboLLM supports without letting someone pick a session that would open a dead
              // terminal. There is no install button here on purpose — onboarding should not stall
              // on a multi-minute `npm i -g`; Settings → Code agent is where it can be installed.
              const installed = isInstalled(a.id)
              return (
                <option key={a.id} value={a.id} disabled={!installed}>
                  {installed ? a.label : `${a.label} — not installed`}
                </option>
              )
            })}
          </select>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        type="button"
        onClick={start}
        disabled={starting}
        className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent/10 text-accent py-2.5 px-5 text-sm font-medium hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {starting ? <Loader2 size={14} className="animate-spin" /> : isDeveloper ? <Terminal size={14} /> : null}
        {starting ? 'Starting…' : isDeveloper ? 'Open Code' : 'Start chatting'}
      </button>

      <div className="flex items-center justify-center gap-5 pt-2 text-sm">
        <button type="button" onClick={exploreModels} className="inline-flex items-center gap-1.5 text-muted hover:text-ink transition-colors">
          <Rocket size={14} />
          Explore models
        </button>
        <button type="button" onClick={visitSite} className="inline-flex items-center gap-1.5 text-muted hover:text-ink transition-colors">
          <ExternalLink size={14} />
          Visit turbollm.dev
        </button>
      </div>
    </div>
  )
}
