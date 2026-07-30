import { useState } from 'react'
import { Button } from './ui/button'
import { useSettings } from '../lib/queries'
import { TELEMETRY_UI_ENABLED } from '../lib/flags'
import type { TelemetryLevel } from '../lib/api'

/**
 * First-run telemetry consent (ADR-299 Decision 4).
 *
 * Shown once, when the stored level is still `'unset'`. There is deliberately
 * **no pre-selected option and no dismiss affordance**: ADR-299 amends ADR-008's
 * "default to the middle level" because for this audience silently-on — even
 * anonymous-only — is the fastest route to a "spyware" thread, while
 * opt-in-buried-in-settings starves the dataset. Forcing a real choice is the
 * only option that is honest in public *and* yields an answer.
 *
 * Not a dark pattern: "Off" is first, styled identically to the others, and
 * costs exactly one click. Nothing is nagged, nothing is re-asked.
 */
export function TelemetryConsentCard() {
  const { query: settingsQ, save } = useSettings()
  const [choice, setChoice] = useState<TelemetryLevel | null>(null)

  // Gated with the rest of the telemetry UI until the ingest Worker is
  // deployed — prompting for consent that leads nowhere would be worse than
  // not asking (the same reasoning as ADR-041).
  if (!TELEMETRY_UI_ENABLED) return null
  if (settingsQ.data === undefined) return null
  // `telemetryLevel` collapses the first-run sentinel to 'off', so "never
  // asked" and "chose Off" look identical there. This flag is the distinction.
  if (settingsQ.data.telemetryDecided) return null

  const options: { value: TelemetryLevel; label: string; desc: string }[] = [
    { value: 'off', label: 'Off', desc: 'Sends only your choice, once. Nothing else, ever.' },
    {
      value: 'anon',
      label: 'Share anonymous usage + benchmarks',
      desc: 'Which features you use, your hardware, model names and speeds. Helps everyone get better speed estimates.',
    },
    { value: 'full', label: 'Also share crash reports', desc: 'Adds error fingerprints so failures can be fixed.' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-panel p-5 shadow-xl">
        <h2 className="text-[15px] font-semibold text-ink">Help improve TurboLLM?</h2>
        <p className="mt-1 text-[12px] text-muted">
          TurboLLM runs entirely on your machine. Optionally, it can send anonymous data about
          which features get used and how fast models run on your hardware — that is what makes
          the speed estimates in the model browser real numbers instead of guesses.
        </p>
        <p className="mt-2 text-[12px] text-muted">
          <span className="font-medium text-ink">Never sent:</span> your conversations, prompts,
          files, file paths, or keys. There is no account and no tracking identity — just a random
          id you can regenerate at any time.
        </p>

        <div className="mt-4 flex flex-col gap-1">
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-2 hover:bg-hover"
            >
              <input
                type="radio"
                name="telemetry-consent"
                value={o.value}
                checked={choice === o.value}
                onChange={() => setChoice(o.value)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              <div>
                <div className="text-[14px] font-medium text-ink">{o.label}</div>
                <div className="text-[12px] text-muted">{o.desc}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Found in pre-release review: a failed save left the button silently
            re-enabled with zero explanation. Every upgrading install reaches
            this card via the v3→v4 migration, so a broken save here was a
            silent, total lockout with no visible cause. This is the fix — NOT
            a dismiss/Escape affordance, which stays deliberately absent (see
            the module doc comment above): the bug was the silence, not the
            requirement to choose. */}
        {save.isError && (
          <p className="mt-3 text-[12px] text-red-500" role="alert">
            {save.error instanceof Error ? save.error.message : 'Something went wrong saving your choice.'}{' '}
            Please try again.
          </p>
        )}

        <div className="mt-4 flex items-center justify-between">
          <span className="text-[11px] text-faint">You can change this any time in Settings.</span>
          {/* Disabled until a choice is made — there is no default to fall back
              on, which is the entire point of this card. */}
          <Button
            size="sm"
            disabled={choice === null || save.isPending}
            onClick={() => choice !== null && save.mutate({ telemetryLevel: choice })}
          >
            {save.isPending ? 'Saving…' : 'Confirm'}
          </Button>
        </div>
      </div>
    </div>
  )
}
