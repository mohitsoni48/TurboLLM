import { Check, Cpu, HardDrive, Loader2, MonitorSmartphone } from 'lucide-react'
import { useEngineBackends, useStatus } from '../../../lib/queries'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step 0 — Welcome + hardware readout (spec 25 §4). Shows what was actually
 *  detected and the REAL engine-provisioning status (ADR-024) — this is the
 *  step that targets the largest measured cliff (68% of installs never finish
 *  the automatic engine install). No consent/ToS gate: that was never part of
 *  the design, and a blocking checkbox before Continue is exactly the pattern
 *  ADR-320 found people abandon. */
export default function WelcomeStep({ onContinue }: StepComponentProps) {
  const { data: status } = useStatus()
  const { data: backends } = useEngineBackends(status?.engineProvision?.active ?? false)
  const provision = status?.engineProvision
  const gpu = backends?.gpus?.[0]

  const provisionDone = !provision || (!provision.active && provision.phase !== 'error')
  const provisionFailed = provision?.phase === 'error'

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 p-4 rounded-lg bg-accent/10 text-accent">
          <MonitorSmartphone size={28} />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-ink mb-1">
            TurboLLM — AI that never leaves your device
          </h3>
          <p className="text-sm text-muted leading-relaxed">
            No cloud, no tracking, no limits. Your conversations stay on your machine.
          </p>
        </div>
      </div>

      <div className="bg-panel-2 border border-border rounded-lg p-4">
        <h4 className="text-sm font-semibold text-ink mb-3">Your machine</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-muted" />
            <span className="text-sm text-ink">{gpu ? gpu.name : 'CPU only'}</span>
          </div>
          <div className="flex items-center gap-2">
            <HardDrive size={14} className="text-muted" />
            <span className="text-sm text-ink">{gpu ? `${Math.round(gpu.vramMb / 1024)} GB VRAM` : 'No discrete GPU'}</span>
          </div>
        </div>
      </div>

      <div className="bg-panel-2 border border-border rounded-lg p-4">
        <h4 className="text-sm font-semibold text-ink mb-3">Engine setup</h4>
        {provisionFailed ? (
          <p className="text-sm text-red-400">
            Setup hit a problem: {provision?.error ?? 'unknown error'}. You can continue — the
            next steps let you recover.
          </p>
        ) : provisionDone ? (
          <div className="flex items-center gap-2 text-sm text-ink">
            <Check size={14} className="text-accent" />
            Ready — llama.cpp is installed
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={14} className="animate-spin text-accent" />
            {provision?.phase === 'downloading' ? 'Downloading the inference engine…' : 'Setting up…'}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end pt-2">
        <button
          type="button"
          onClick={onContinue}
          className="inline-flex items-center gap-2 rounded-md border border-accent bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
