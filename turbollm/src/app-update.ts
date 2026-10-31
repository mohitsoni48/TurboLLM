// App self-update check (F-006, ADR-031). The *app* analog of the per-engine update
// checker (ADR-085, src/engines/update.ts): is a newer TurboLLM published on npm than
// the version we're running? Informational only — npm does the actual upgrade
// (`npm i -g turbollm`); we never auto-update or restart ourselves.
//
// Same shape as the engine checker: the DECISION (compare installed vs latest) is the
// pure, unit-tested semver comparator reused from engines/update.ts, and the I/O (the
// npm registry fetch) is a thin shell that NEVER fabricates a "latest" on a network
// failure — offline reports a "couldn't check" state instead of a false answer.

import { type CompareResult, comparePipVersions } from './engines/update'
import { API_TIMEOUT_MS, withTimeout } from './util/fetch-timeout'

/** Compare two app versions (semver `1.0.0` shape). Reuses the engine checker's
 *  numeric dotted-release comparator (pre-release/build suffixes ignored — npm's
 *  `latest` dist-tag is always a stable release, which is all this check compares).
 *  Result is stated from the latest's perspective: `newer` = an update is available. */
export function compareAppVersions(installed: string, latest: string): CompareResult {
  return comparePipVersions(installed, latest)
}

/** Result of an app update check. On success `latest`/`hasUpdate` carry the compared
 *  answer; on a network failure `error: 'offline'` is set and `latest`/`hasUpdate`
 *  stay null/false — we never claim a "latest" we couldn't actually fetch (offline-
 *  first, ADR-009). `checkedAt` is always set (drives the 24h cache TTL). */
export interface AppUpdateStatus {
  /** The running version we compared against (from package.json via the daemon). */
  installed: string
  /** The real npm `latest`, or null when the check failed. */
  latest: string | null
  hasUpdate: boolean
  /** ISO timestamp of when this status was produced. */
  checkedAt: string
  /** Set when the check could not complete (network unreachable). Mutually exclusive
   *  with a non-null latest. */
  error?: 'offline'
  /** False when latest couldn't be parsed/compared against installed (`unknown`) — the
   *  UI then stays silent rather than showing a false "up to date". */
  comparable: boolean
}

/** The npm package the app is published as (F-006). */
export const APP_PACKAGE = 'turbollm'

/** Resolve the real latest published version from the npm registry. Hits the cheap
 *  per-package `latest` endpoint (no full metadata download). Throws on network
 *  failure — the caller maps that to an `offline` status, never a fabricated latest. */
export async function fetchNpmLatest(signal?: AbortSignal, timeoutMs = API_TIMEOUT_MS): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${APP_PACKAGE}/latest`, {
    headers: { Accept: 'application/json', 'User-Agent': 'turbollm' },
    signal: withTimeout(signal, timeoutMs),
  })
  if (!res.ok) throw new Error(`npm query failed: HTTP ${res.status}`)
  const data = (await res.json()) as { version?: string }
  return data.version ?? ''
}

/** Produce an {@link AppUpdateStatus} for the running version. Fetches npm's latest and
 *  compares — never inventing a latest on failure. `fetcher` is injectable so tests can
 *  drive the comparison + offline behavior without network. */
export async function computeAppUpdateStatus(
  installed: string,
  fetcher: (signal?: AbortSignal) => Promise<string> = fetchNpmLatest,
  signal?: AbortSignal,
): Promise<AppUpdateStatus> {
  const checkedAt = new Date().toISOString()
  let latest: string
  try {
    latest = await fetcher(signal)
  } catch {
    return { installed, latest: null, hasUpdate: false, checkedAt, error: 'offline', comparable: false }
  }
  if (!latest) {
    return { installed, latest: null, hasUpdate: false, checkedAt, error: 'offline', comparable: false }
  }
  const cmp = compareAppVersions(installed, latest)
  return {
    installed,
    latest,
    hasUpdate: cmp === 'newer',
    checkedAt,
    comparable: cmp !== 'unknown',
  }
}

/** How long a successful check is trusted before a re-check is warranted (ADR-031:
 *  "cache result for 24h"). */
export const APP_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h

/** Process-lifetime cache of the last app-update check, with its timestamp. Offline-
 *  first: a cached successful status survives a later network failure so the UI keeps
 *  showing the last real answer instead of flapping to "couldn't check". Singleton (the
 *  app checks exactly one version), unlike the per-engine {@link UpdateChecker}. */
export class AppUpdateChecker {
  private cache: AppUpdateStatus | null = null

  constructor(
    private installed: string,
    private fetcher: (signal?: AbortSignal) => Promise<string> = fetchNpmLatest,
  ) {}

  /** The last cached status, or null when never checked. */
  get(): AppUpdateStatus | null {
    return this.cache
  }

  /** True when there's no cached status or it's older than the 24h TTL — i.e. a
   *  re-check is warranted. `now` is injectable for tests. */
  isStale(now: number = Date.now()): boolean {
    if (!this.cache) return true
    const at = Date.parse(this.cache.checkedAt)
    return !Number.isFinite(at) || now - at >= APP_UPDATE_CHECK_INTERVAL_MS
  }

  /** Re-check and cache the result. On an offline result we KEEP a prior successful
   *  status (don't overwrite a real latest with "couldn't check"); the UI's relative
   *  time naturally ages. Returns the status used. */
  async check(signal?: AbortSignal): Promise<AppUpdateStatus> {
    const fresh = await computeAppUpdateStatus(this.installed, this.fetcher, signal)
    if (fresh.error === 'offline' && this.cache && this.cache.latest !== null) return this.cache
    this.cache = fresh
    return fresh
  }
}
