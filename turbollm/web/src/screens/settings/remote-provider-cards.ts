import type { RemoteProviderId } from '../../lib/remote-api'

/** Provider cards, engines-catalog convention: pros and cons only, no prose blocks.
 *
 *  Every cost here is a real, documented one, stated BEFORE the user commits rather than
 *  discovered afterwards — Cloudflare's own quick-tunnel limits, ngrok's free-tier
 *  interstitial (which lands in front of this very UI), and Funnel's deliberate absence of
 *  identity headers. */
export const PROVIDER_CARDS: Record<RemoteProviderId, { title: string; pros: string[]; cons: string[] }> = {
  'cloudflare-quick': {
    title: 'Cloudflare quick tunnel',
    pros: ['No account, no setup', 'Works in one click'],
    cons: ['URL changes on every restart', '200 concurrent requests', 'No uptime guarantee'],
  },
  'cloudflare-named': {
    title: 'Cloudflare named tunnel',
    pros: ['Your own stable hostname', 'Your Cloudflare account', 'Works with Cloudflare Access SSO'],
    cons: ['Needs a domain on Cloudflare', 'Token pasted from the dashboard'],
  },
  'tailscale-serve': {
    title: 'Tailscale Serve',
    pros: ['Your devices only — not public', 'Stable hostname', 'Signs you in automatically'],
    cons: ['Needs Tailscale installed and logged in', 'Others cannot reach it'],
  },
  'tailscale-funnel': {
    title: 'Tailscale Funnel',
    pros: ['Public and stable', 'Free on any Tailscale plan'],
    cons: ['Public · no identity headers', 'Ports 443, 8443 or 10000 only', 'Bandwidth limits apply'],
  },
  ngrok: {
    title: 'ngrok',
    pros: ['Reserved domains on paid plans', 'Well-known tooling'],
    cons: ['Free tier: 2-hour sessions', 'Free tier shows an interstitial page in front of this UI'],
  },
  custom: {
    title: 'I run my own',
    pros: ['Any tunnel — frp, rathole, zrok, Pinggy, your own VPS', 'Nothing extra installed'],
    cons: ['You keep it running', 'You supply the URL'],
  },
}
