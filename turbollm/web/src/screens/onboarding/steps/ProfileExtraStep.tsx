import { useState } from 'react'
import { Check, Copy, Cpu, Settings2, Shield } from 'lucide-react'
import { useEngines } from '../../../lib/queries'
import { activateEngine } from '../../../lib/api'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step 4 — Profile step (spec 25 §4), runs during the download.
 *  - Developer: tool-permission note + a copyable OpenAI/Anthropic-compatible
 *    endpoint (real port — CLAUDE.md's hard-coded 6996).
 *  - Pro: a real engine picker over the actually-installed catalog
 *    (`useEngines()`), not a static list of names. Casual never reaches this
 *    step at all (`registry.ts`'s `appliesTo` excludes it); Enthusiast's
 *    variant is the auto-tune intro, handled by falling through to the
 *    generic branch below since it has nothing extra to configure here. */
export default function ProfileExtraStep({ onContinue, ctx }: StepComponentProps) {
  const [copied, setCopied] = useState(false)
  const enginesQuery = useEngines()
  const [activating, setActivating] = useState<string | null>(null)

  const endpoint = `${window.location.protocol}//${window.location.hostname}:6996/v1`

  const copyEndpoint = async () => {
    await navigator.clipboard.writeText(endpoint)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const pickEngine = async (id: string) => {
    setActivating(id)
    try {
      await activateEngine(id)
    } finally {
      setActivating(null)
    }
  }

  if (ctx.profile === 'developer') {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Settings2 size={20} className="text-accent" />
          <h3 className="text-lg font-semibold text-ink">Set up your workflow</h3>
        </div>

        <div className="bg-panel-2 border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-3">
            <Shield size={16} className="text-muted" />
            <p className="text-sm text-ink">
              Tool calls (file edits, shell commands) ask for approval by default — change that
              any time in Settings → Tool permissions.
            </p>
          </div>
        </div>

        <div className="bg-panel-2 border border-border rounded-xl p-5">
          <h4 className="text-sm font-semibold text-ink mb-2">OpenAI/Anthropic-compatible endpoint</h4>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono text-muted bg-panel rounded px-3 py-2 truncate">{endpoint}</code>
            <button
              type="button"
              onClick={copyEndpoint}
              className="flex-shrink-0 p-2 rounded-lg border border-border hover:border-accent/50 transition-colors"
            >
              {copied ? <Check size={14} className="text-accent" /> : <Copy size={14} className="text-muted" />}
            </button>
          </div>
          <p className="text-xs text-muted mt-2">Point Claude Code, Cursor, or any compatible client here.</p>
        </div>

        <div className="flex items-center justify-end pt-2">
          <button
            type="button"
            onClick={onContinue}
            className="rounded-lg border border-accent bg-accent/10 text-accent px-4 py-2 text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  if (ctx.profile === 'pro') {
    const engines = enginesQuery.data?.engines ?? []
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Cpu size={20} className="text-accent" />
          <h3 className="text-lg font-semibold text-ink">Choose your engine</h3>
        </div>
        <p className="text-sm text-muted mb-6">Installed and available on this machine.</p>

        <div className="grid gap-2">
          {engines.map((engine) => (
            <button
              type="button"
              key={engine.id}
              onClick={() => pickEngine(engine.id)}
              disabled={activating === engine.id}
              className={`flex items-center justify-between p-3 rounded-lg border transition-colors text-left ${
                engine.id === enginesQuery.data?.activeEngineId
                  ? 'border-accent bg-accent/5'
                  : 'border-border bg-panel hover:border-accent/30'
              }`}
            >
              <span className="text-sm text-ink">{engine.name}</span>
              {engine.id === enginesQuery.data?.activeEngineId && <Check size={14} className="text-accent" />}
            </button>
          ))}
          {engines.length === 0 && (
            <p className="text-sm text-muted">No engines installed yet — the default install is still running.</p>
          )}
        </div>

        <div className="flex items-center justify-end pt-2">
          <button
            type="button"
            onClick={onContinue}
            className="rounded-lg border border-accent bg-accent/10 text-accent px-4 py-2 text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  // Unreachable in practice: `registry.ts`'s appliesTo restricts this step to
  // developer/pro. Rendered defensively rather than crashing if that ever drifts.
  return null
}
