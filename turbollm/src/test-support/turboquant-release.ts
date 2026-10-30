// A stubbed GitHub release list for the TurboQuant fork, in its real layout: one release tagged
// b<build>-<semver> carrying an archive per platform and variant (llama-turboquant-<os>-<arch>-<variant>).
// Every variant this OS could be offered is listed, so whichever one the machine running the tests resolves
// to (a CI runner has no GPU, a dev box may have one) finds its archive. A test serves one archive for all of
// them: the build it stages is the same whichever was chosen.
import type { GithubRelease } from '../engines/download'

export const TURBOQUANT_FIXTURE_TAG = 'b200-2.0.0'

const LINUX_VARIANTS = ['cpu', 'vulkan', 'rocm', 'cuda-12.4', 'cuda-13.3']

function assetNames(): string[] {
  if (process.platform === 'darwin') return ['llama-turboquant-macos-arm64.tar.gz']
  return LINUX_VARIANTS.map((variant) => `llama-turboquant-linux-x64-${variant}.tar.gz`)
}

export function turboquantReleaseList(): GithubRelease[] {
  return [{
    tag_name: TURBOQUANT_FIXTURE_TAG,
    assets: assetNames().map((name) => ({ name, browser_download_url: `https://cdn.test/${name}` })),
  }]
}
