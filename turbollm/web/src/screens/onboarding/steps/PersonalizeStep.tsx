import { useState } from 'react'
import { UserCircle } from 'lucide-react'
import { getPersonalization, savePersonalization } from '../../../lib/personas'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step 3 — Personalize (spec 25 §4), runs during the download.
 *
 *  Reuses the REAL, existing ADR-057 personalization store
 *  (`getPersonalization`/`savePersonalization` in `lib/personas.ts`) rather
 *  than inventing a parallel "interests" concept — assistant name and the
 *  user's own name are the two fields that surface, exactly the same ones
 *  Settings → Personalize already persists.
 *
 *  Scope note: `lib/personas.ts` has no exported default-persona getter/setter
 *  (only a private localStorage key), so default-persona selection is left
 *  for a later pass rather than reached into past the module's public API. */
export default function PersonalizeStep({ onContinue }: StepComponentProps) {
  const [p, setP] = useState(() => getPersonalization())

  const handleContinue = () => {
    savePersonalization(p)
    onContinue()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <UserCircle size={20} className="text-accent" />
        <h3 className="text-lg font-semibold text-ink">Personalize your experience</h3>
      </div>
      <p className="text-sm text-muted mb-6">
        Optional — this is the same personalization you'll find later in Settings.
      </p>

      <div className="bg-panel-2 border border-border rounded-xl p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-ink mb-1.5">Your name (optional)</label>
          <input
            value={p.userName}
            onChange={(e) => setP((prev) => ({ ...prev, userName: e.target.value }))}
            placeholder="Your name"
            className="w-full rounded-lg border border-border bg-panel px-4 py-2 text-sm text-ink outline-none focus:border-accent transition-colors placeholder:text-faint"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ink mb-1.5">Assistant name (optional)</label>
          <input
            value={p.assistantName}
            onChange={(e) => setP((prev) => ({ ...prev, assistantName: e.target.value }))}
            placeholder="TurboLLM"
            className="w-full rounded-lg border border-border bg-panel px-4 py-2 text-sm text-ink outline-none focus:border-accent transition-colors placeholder:text-faint"
          />
        </div>
      </div>

      <div className="flex items-center justify-end pt-2">
        <button
          type="button"
          onClick={handleContinue}
          className="rounded-lg border border-accent bg-accent/10 text-accent px-4 py-2 text-sm font-medium hover:bg-accent/20 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
