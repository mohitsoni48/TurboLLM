import assert from 'node:assert/strict'
import { hostname, release } from 'node:os'
import { test } from 'node:test'
import { hostUname, vllmModelRunnerEnv } from './vllm'

// vLLM 0.29 defaults to Model Runner V2, which needs UVA (pinned host memory). vLLM turns pinned
// memory off under WSL, so V2 dies at engine-core init with "UVA is not available" before any
// model code runs. The V1 runner still ships and works there.

const WSL2_UNAME = 'Linux DESKTOP-7Q2 6.18.33.1-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC x86_64'
const NATIVE_UNAME = 'Linux gpu-box 6.8.0-49-generic #49-Ubuntu SMP PREEMPT_DYNAMIC x86_64'

test('vllmModelRunnerEnv: a WSL distro selects the V1 model runner', () => {
  assert.deepEqual(vllmModelRunnerEnv({ WSL_DISTRO_NAME: 'Ubuntu-24.04' }, NATIVE_UNAME), { VLLM_USE_V2_MODEL_RUNNER: '0' })
})

test('vllmModelRunnerEnv: a WSL kernel selects V1 even without WSL_DISTRO_NAME (systemd service, Docker Desktop)', () => {
  assert.deepEqual(vllmModelRunnerEnv({}, WSL2_UNAME), { VLLM_USE_V2_MODEL_RUNNER: '0' })
})

test('vllmModelRunnerEnv: native Linux leaves the runner choice to vLLM', () => {
  assert.deepEqual(vllmModelRunnerEnv({}, NATIVE_UNAME), {})
})

test('vllmModelRunnerEnv: a host with no uname (Windows, macOS) leaves the runner choice to vLLM', () => {
  assert.deepEqual(vllmModelRunnerEnv({}, ''), {})
})

test('vllmModelRunnerEnv: a runner the user already chose is never overridden, even on WSL', () => {
  const userChoseV2 = { WSL_DISTRO_NAME: 'Ubuntu-24.04', VLLM_USE_V2_MODEL_RUNNER: '1' }
  assert.deepEqual(vllmModelRunnerEnv(userChoseV2, WSL2_UNAME), {})
})

test('vllmModelRunnerEnv: a blank runner value is not a choice (vLLM would crash parsing it), so WSL still gets V1', () => {
  const blankLeftInDotEnv = { VLLM_USE_V2_MODEL_RUNNER: ' ' }
  assert.deepEqual(vllmModelRunnerEnv(blankLeftInDotEnv, WSL2_UNAME), { VLLM_USE_V2_MODEL_RUNNER: '0' })
})

function onPlatform<T>(platform: NodeJS.Platform, read: () => T): T {
  const actual = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return read()
  } finally {
    Object.defineProperty(process, 'platform', { value: actual })
  }
}

test('hostUname: on Linux it carries the kernel release, where WSL2 says "microsoft"', () => {
  assert.ok(onPlatform('linux', hostUname).includes(release()))
})

test('hostUname: on Linux it carries the hostname too, because vLLM\'s in_wsl() reads the whole uname', () => {
  assert.ok(onPlatform('linux', hostUname).includes(hostname()))
})

test('hostUname: off Linux there is no uname to read, so it is empty', () => {
  assert.equal(onPlatform('win32', hostUname), '')
})
