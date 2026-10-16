// GET /status `engineBuild` carries every BuildState run, and not all of them build an engine: the Windows CUDA
// Toolkit download and the build guide's package-manager prerequisite installs stream through it too (the daemon
// names those after the tool they install).
import type { EngineBuild } from './types'

/** The engineBuild labels of the runs that build no engine. */
export const NOT_AN_ENGINE_BUILD = new Set(['CUDA Toolkit', 'git', 'cmake', 'gcc', 'cuda'])

/** A build from source is running. The daemon then refuses to add, enable, disable or delete an engine (409
 *  engine_already_running), so the Engines screen disables those actions, as it does during a download; they stayed
 *  clickable and each click only showed "A build is in progress". A CUDA Toolkit download or a prerequisite install
 *  leaves them open, here and in the daemon. */
export function engineBuildRunning(eb: EngineBuild | undefined): boolean {
  return !!eb?.active && !NOT_AN_ENGINE_BUILD.has(eb.engine)
}
