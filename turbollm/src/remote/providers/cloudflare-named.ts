// A remotely-managed Cloudflare tunnel (spec 30 §3.2) — the answer to "let me use my own
// Cloudflare account".
//
// Two things a reader should not have to rediscover:
//   1. A remotely-managed tunnel's public hostname lives in the Zero Trust dashboard, not in
//      anything cloudflared prints locally. We CANNOT discover it, so the user supplies it
//      and the UI says plainly it must match what they mapped. This is why publicUrl() is a
//      config read rather than a stderr parse like the quick tunnel's.
//   2. A FREE Cloudflare account with a zone is sufficient. The founder's ask mentioned
//      "paid or premium subscriptions"; a paid plan buys nothing extra for this, and the UI
//      must say so rather than implying a purchase is needed.
import { ensureCloudflared } from '../../tunnel/provision'
import { ChildTunnel } from '../child-process'
import type { PreflightState, RemoteProvider } from '../types'

export interface CloudflareNamedConfig {
  tunnelToken: string
  hostname: string
}

/** A bare host, as the dashboard's Public Hostname field holds it — no scheme, no path, no
 *  port. Anything else is a paste error we can catch before it becomes a dead URL. */
function isBareHost(v: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)
}

export class CloudflareNamedProvider implements RemoteProvider {
  readonly id = 'cloudflare-named' as const
  readonly lifecycle = 'child-process' as const
  private child: ChildTunnel

  constructor(
    private dataDir: string,
    private cfg: CloudflareNamedConfig,
  ) {
    this.child = new ChildTunnel(dataDir)
  }

  async preflight(): Promise<PreflightState> {
    if (!this.cfg.tunnelToken) {
      return { kind: 'needs-setup', reason: 'Paste the tunnel token from your Cloudflare Zero Trust dashboard.' }
    }
    if (!this.cfg.hostname) {
      return { kind: 'needs-setup', reason: 'Enter the public hostname you mapped to this tunnel in the dashboard.' }
    }
    if (!isBareHost(this.cfg.hostname)) {
      return {
        kind: 'needs-setup',
        reason: 'The hostname must be a bare host such as llm.example.com — no https://, no path.',
      }
    }
    return { kind: 'off' }
  }

  argv(): string[] {
    return ['tunnel', 'run', '--token', this.cfg.tunnelToken]
  }

  publicUrl(): string {
    return `https://${this.cfg.hostname}`
  }

  /** Unlike the quick tunnel there is no URL to parse — cloudflared prints connection
   *  registrations, not a hostname. Wait for the registration line instead, so "started"
   *  still means "the edge accepted us" rather than merely "the process launched". */
  async start(): Promise<{ url: string }> {
    const { binPath } = await ensureCloudflared(this.dataDir)
    await this.child.spawnAndWait(binPath, this.argv(), /Registered tunnel connection|Connection [0-9a-f-]+ registered/i)
    return { url: this.publicUrl() }
  }

  stop(): Promise<void> {
    return this.child.stop()
  }

  alive(): boolean {
    return this.child.alive()
  }

  onExit(cb: (code: number | null) => void): void {
    this.child.onExit(cb)
  }
}
