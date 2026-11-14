// Internal API routes (/api/v1/*) per spec 02. Thin handlers over config/engines.
// Each group lives in its own module (scalability item 5.1); registerApi mounts them in the order they were always
// registered, because Hono matches overlapping routes in registration order (server.route-order.test.ts,
// routes.route-table.test.ts).
import type { Hono } from 'hono'
import type { Deps } from '../deps'
import { registerActivityRoutes } from './active-work'
import { registerAppUpdateRoutes } from './app-update-routes'
import { registerArtifactRoutes } from './artifact-routes'
import { registerBuildRoutes } from './build-routes'
import { registerDiagnosticsRoutes } from './diagnostics-routes'
import { registerDownloadsHfRoutes } from './downloads-hf-routes'
import { registerEngineInstallRoutes } from './engine-install-routes'
import { registerEngineManageRoutes } from './engine-manage-routes'
import { registerEngineRegistryRoutes } from './engine-registry-routes'
import { registerEngineReleaseRoutes } from './engine-release-routes'
import { createEngineJobs } from './engine-work'
import { registerEngineRoutes } from './engines-routes'
import { registerFsRoutes } from './fs-routes'
import { registerKeysConnectRoutes, registerNetworkInfoRoutes } from './keys-connect-routes'
import { registerLifecycleRoutes } from './lifecycle-routes'
import { registerMcpRoutes } from './mcp-routes'
import { registerModelRoutes } from './models-routes'
import { registerOnboardingRoutes } from './onboarding-routes'
import { registerSandboxRuntimeRoutes } from './sandbox-runtime-routes'
import { registerSettingsRoutes } from './settings-routes'
import { registerStatusRoutes } from './status-routes'
import { registerSystemOneJobRoutes } from './systemone-job'
import { registerTelemetryRoutes } from './telemetry-routes'

export { engineWorkBusy } from './engine-work'
export { MCP_ENV_MASK } from './mcp-routes'
export { buildConnectSnippets } from './keys-connect-routes'

export function registerApi(app: Hono, d: Deps): void {
  const jobs = createEngineJobs()
  registerStatusRoutes(app, d, jobs)

  // What a model load would interrupt (ADR-434 (i)(3)). Its own module, like every group here, registered
  // HERE and synchronously so it can never end up behind the SPA fallback (ADR-421).
  registerActivityRoutes(app, d)

  registerArtifactRoutes(app, d)
  registerEngineRoutes(app, d, jobs)
  registerBuildRoutes(app, d, jobs)
  registerEngineInstallRoutes(app, d, jobs)
  registerEngineRegistryRoutes(app, d, jobs)
  // Registered before engine-manage's PUT/DELETE /engines/:id, which would otherwise swallow "release".
  registerEngineReleaseRoutes(app, d, jobs)
  registerEngineManageRoutes(app, d, jobs)
  registerAppUpdateRoutes(app, d)
  registerFsRoutes(app, d)
  registerLifecycleRoutes(app, d)
  registerDiagnosticsRoutes(app, d)
  registerModelRoutes(app, d)
  registerSettingsRoutes(app, d)
  registerMcpRoutes(app, d)
  registerTelemetryRoutes(app, d)
  registerNetworkInfoRoutes(app, d)
  registerDownloadsHfRoutes(app, d)
  registerKeysConnectRoutes(app, d)

  // ---- onboarding (spec 25 §9.2) ----
  registerOnboardingRoutes(app, { store: d.store, telemetry: d.telemetry })
  // The text classification playground's run, as a job a page closing does not stop (systemone-job.ts).
  registerSystemOneJobRoutes(app, d)
  // The Python sandbox's runtime download (GitHub #52).
  registerSandboxRuntimeRoutes(app, d)
}
