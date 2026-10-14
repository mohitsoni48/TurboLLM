// Real asset name lists captured with `gh release view` on 2026-10-10, used by release-assets tests.
import type { ReleaseAsset } from './download'

export interface FixtureAsset extends ReleaseAsset {
  size?: number
}

export function assetsNamed(names: string[]): FixtureAsset[] {
  return names.map((name) => ({ name, browser_download_url: `https://example.invalid/dl/${name}` }))
}

export const PRISM_TAG = 'prism-b10770-6684606'
const PRISM = 'llama-prism-b10770-6684606'
export const PRISM_B10770 = [
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.3-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-arm64.zip',
  `${PRISM}-bin-android-arm64.tar.gz`,
  `${PRISM}-bin-linux-cuda-12.4-x64.tar.gz`,
  `${PRISM}-bin-linux-cuda-12.8-x64.tar.gz`,
  `${PRISM}-bin-linux-cuda-13.3-x64.tar.gz`,
  `${PRISM}-bin-macos-arm64-kleidiai.tar.gz`,
  `${PRISM}-bin-macos-arm64.tar.gz`,
  `${PRISM}-bin-macos-x64.tar.gz`,
  `${PRISM}-bin-ubuntu-arm64.tar.gz`,
  `${PRISM}-bin-ubuntu-rocm-7.2-x64.tar.gz`,
  `${PRISM}-bin-ubuntu-sycl-fp16-x64.tar.gz`,
  `${PRISM}-bin-ubuntu-sycl-fp32-x64.tar.gz`,
  `${PRISM}-bin-ubuntu-vulkan-arm64.tar.gz`,
  `${PRISM}-bin-ubuntu-vulkan-x64.tar.gz`,
  `${PRISM}-bin-ubuntu-x64.tar.gz`,
  `${PRISM}-bin-win-cpu-arm64.zip`,
  `${PRISM}-bin-win-cpu-x64.zip`,
  `${PRISM}-bin-win-cuda-12.4-x64.zip`,
  `${PRISM}-bin-win-cuda-13.3-x64.zip`,
  `${PRISM}-bin-win-cuda-13.4-arm64.zip`,
  `${PRISM}-bin-win-hip-radeon-x64.zip`,
  `${PRISM}-bin-win-sycl-x64.zip`,
  `${PRISM}-bin-win-vulkan-x64.zip`,
  `${PRISM}-xcframework.zip`,
]

export const BEELLAMA_TAG = 'v0.4.7'
export const BEELLAMA_V047 = [
  'beellama-v0.4.7-bin-macos-arm64.tar.gz',
  'beellama-v0.4.7-bin-ubuntu-arm64.tar.gz',
  'beellama-v0.4.7-bin-ubuntu-cuda-12.4-x64.tar.gz',
  'beellama-v0.4.7-bin-ubuntu-cuda-13.3-x64.tar.gz',
  'beellama-v0.4.7-bin-ubuntu-rocm-7.2-x64.tar.gz',
  'beellama-v0.4.7-bin-ubuntu-sycl-x64.tar.gz',
  'beellama-v0.4.7-bin-ubuntu-vulkan-x64.tar.gz',
  'beellama-v0.4.7-bin-ubuntu-x64.tar.gz',
  'beellama-v0.4.7-bin-win-cpu-x64.zip',
  'beellama-v0.4.7-bin-win-cuda-12.4-x64.zip',
  'beellama-v0.4.7-bin-win-cuda-13.3-x64.zip',
  'beellama-v0.4.7-bin-win-hip-radeon-x64.zip',
  'beellama-v0.4.7-bin-win-sycl-x64.zip',
  'beellama-v0.4.7-bin-win-vulkan-x64.zip',
  'beellama-v0.4.7-cudart-win-cuda-12.4-x64.zip',
  'beellama-v0.4.7-cudart-win-cuda-13.3-x64.zip',
  'SHA256SUMS.txt',
]

export const OFFICIAL_TAG = 'b9608'
export const OFFICIAL_B9608 = [
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.3-x64.zip',
  'llama-b9608-bin-android-arm64.tar.gz',
  'llama-b9608-bin-macos-arm64.tar.gz',
  'llama-b9608-bin-macos-x64.tar.gz',
  'llama-b9608-bin-ubuntu-arm64.tar.gz',
  'llama-b9608-bin-ubuntu-openvino-2026.0-x64.tar.gz',
  'llama-b9608-bin-ubuntu-rocm-7.2-x64.tar.gz',
  'llama-b9608-bin-ubuntu-s390x.tar.gz',
  'llama-b9608-bin-ubuntu-sycl-fp16-x64.tar.gz',
  'llama-b9608-bin-ubuntu-sycl-fp32-x64.tar.gz',
  'llama-b9608-bin-ubuntu-vulkan-arm64.tar.gz',
  'llama-b9608-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b9608-bin-ubuntu-x64.tar.gz',
  'llama-b9608-bin-win-cpu-arm64.zip',
  'llama-b9608-bin-win-cpu-x64.zip',
  'llama-b9608-bin-win-cuda-12.4-x64.zip',
  'llama-b9608-bin-win-cuda-13.3-x64.zip',
  'llama-b9608-bin-win-hip-radeon-x64.zip',
  'llama-b9608-bin-win-opencl-adreno-arm64.zip',
  'llama-b9608-bin-win-sycl-x64.zip',
  'llama-b9608-bin-win-vulkan-x64.zip',
  'llama-b9608-ui.tar.gz',
  'llama-b9608-xcframework.zip',
]

export const TURBOQUANT_B10298 = [
  'llama-turboquant-linux-arm64-cuda-13.3.tar.gz',
  'llama-turboquant-linux-arm64-cuda-13.3.zip',
  'llama-turboquant-linux-x64-cpu.tar.gz',
  'llama-turboquant-linux-x64-cpu.zip',
  'llama-turboquant-linux-x64-cuda-12.4.tar.gz',
  'llama-turboquant-linux-x64-cuda-12.4.zip',
  'llama-turboquant-linux-x64-cuda-13.3.tar.gz',
  'llama-turboquant-linux-x64-cuda-13.3.zip',
  'llama-turboquant-linux-x64-rocm.tar.gz',
  'llama-turboquant-linux-x64-rocm.zip',
  'llama-turboquant-linux-x64-vulkan.tar.gz',
  'llama-turboquant-linux-x64-vulkan.zip',
  'llama-turboquant-macos-arm64.tar.gz',
  'llama-turboquant-macos-arm64.zip',
  'llama-turboquant-windows-x64-cpu.zip',
  'llama-turboquant-windows-x64-cuda-12.4.zip',
  'llama-turboquant-windows-x64-cuda-13.3.zip',
  'llama-turboquant-windows-x64-rocm.zip',
  'llama-turboquant-windows-x64-vulkan.zip',
]

export const KOBOLDCPP_V1_122_1 = [
  'koboldcpp-linux-x64',
  'koboldcpp-linux-x64-nocuda',
  'koboldcpp-linux-x64-oldpc',
  'koboldcpp-mac-arm64',
  'koboldcpp-nocuda.exe',
  'koboldcpp-oldpc.exe',
  'koboldcpp.exe',
]
