// GET /status `engineBuild` carries every BuildState run, and not all of them build an engine: the Windows CUDA
// Toolkit download and the build guide's package-manager prerequisite installs stream through it too (the daemon
// names those after the tool they install, and marks them toolInstall).
import type { EngineBuild } from './types'

/** The engineBuild labels of the runs that build no engine, for a daemon that does not send toolInstall. */
const NOT_AN_ENGINE_BUILD = new Set(['CUDA Toolkit', 'git', 'cmake', 'gcc', 'cuda'])

/** The run installs a build tool and builds no engine. Told by the daemon's toolInstall, not by the label: a build's
 *  name is the user's to pick, and a build named "cuda", "git", "cmake" or "gcc" was taken for a tool install, which
 *  left open the card actions the daemon refused (409) on every click. The labels are only the fallback for a
 *  daemon that predates the field. */
export function isToolInstall(eb: EngineBuild): boolean {
  return eb.toolInstall ?? NOT_AN_ENGINE_BUILD.has(eb.engine)
}

/** A build from source is running. The daemon then refuses to add, enable, disable or delete an engine (409
 *  engine_already_running), so the Engines screen disables those actions, as it does during a download; they stayed
 *  clickable and each click only showed "A build is in progress". A CUDA Toolkit download or a prerequisite install
 *  leaves them open, here and in the daemon. */
export function engineBuildRunning(eb: EngineBuild | undefined): boolean {
  return !!eb?.active && !isToolInstall(eb)
}
