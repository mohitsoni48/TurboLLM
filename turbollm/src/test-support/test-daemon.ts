// A real daemon booted in the test's own process (boot.ts bootDaemon), but inert: a temp data dir, a free loopback
// port, no telemetry, no engine (the first-run engine seed is marked done), no model dir of the user's (a temp one
// is configured), no auto-load, no npm update check and no Tailscale reconcile. It never touches ~/.turbollm, never
// binds a fixed port and reaches nothing beyond loopback.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bootDaemon, type BootedDaemon, type BootOptions } from '../boot'
import { ConfigStore, type Config } from '../config/config'
import { TELEMETRY_ENV } from '../telemetry/disabled'
import { stopDaemonTicks } from '../util/daemon-ticks'
import { tmpDir } from './tmp'

export interface TestDaemon extends BootedDaemon {
  /** `http://127.0.0.1:<bound port>`. */
  origin: string
  dataDir: string
  /** close(), then stops the daemon's ticks (the restart keeper's job in a real daemon). */
  stop(): Promise<void>
}

/** The telemetry env var as it was before the first running test daemon set it, and how many are running. */
let telemetryBefore: { value: string | undefined; running: number } | null = null

/** Boots a test daemon; `configure` edits its config before the boot reads it, `options` turns one of the inert
 *  defaults back on (such as auto-load). */
export async function bootTestDaemon(configure: (c: Config) => void = () => {}, options: Partial<BootOptions> = {}): Promise<TestDaemon> {
  // The `--no-telemetry` mechanism itself (ADR-299: the flag is this env var, not a second code path).
  telemetryBefore ??= { value: process.env[TELEMETRY_ENV], running: 0 }
  telemetryBefore.running++
  process.env[TELEMETRY_ENV] = 'off'
  const dataDir = tmpDir('tllm-boot-')
  const modelDir = join(dataDir, 'models')
  mkdirSync(modelDir)
  const store = ConfigStore.load(join(dataDir, 'config.json'))
  store.update((c) => {
    c.defaultEngineSeeded = true
    c.modelDirs = [modelDir]
    c.daemon.openBrowserOnStart = false
    configure(c)
  })
  const daemon = await bootDaemon({
    store,
    version: 'test',
    listenPort: 0,
    openBrowser: false,
    printToken: false,
    tunnel: false,
    autoLoad: false,
    checkAppUpdates: false,
    reconcileTailscale: false,
    ...options,
  })
  const port = await boundPort(daemon)
  return {
    ...daemon,
    origin: `http://127.0.0.1:${port}`,
    dataDir,
    async stop() {
      await daemon.close()
      stopDaemonTicks()
      restoreTelemetryEnv()
    },
  }
}

/** Puts the telemetry env var back once the last running test daemon has stopped. */
function restoreTelemetryEnv(): void {
  if (!telemetryBefore || --telemetryBefore.running > 0) return
  if (telemetryBefore.value === undefined) delete process.env[TELEMETRY_ENV]
  else process.env[TELEMETRY_ENV] = telemetryBefore.value
  telemetryBefore = null
}

/** The port the listener bound, once its listen callback has run. */
async function boundPort(daemon: BootedDaemon): Promise<number> {
  for (let waited = 0; waited < 10_000; waited += 10) {
    if (daemon.deps.bindPort) return daemon.deps.bindPort
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the test daemon did not bind within 10 s')
}
