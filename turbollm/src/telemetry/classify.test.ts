import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLoadFailure, classifyBenchFailure, classifyEngineErrorFingerprint, classifyProvisionFailure, classifyHarness } from './classify'
import { FAIL_REASONS, ERROR_FINGERPRINTS, PROVISION_FAIL_REASONS } from './schema'
import { HARNESSES } from './events/gateway'

function err(over: Partial<{ code: string; message: string; logTail: string[] }> = {}) {
  return { code: 'load_failed', message: '', exitCode: 1, logTail: [], ...over }
}

test('classifyLoadFailure: always returns a value from the enum, never raw text', () => {
  const inputs = [
    err({ message: 'CUDA error: out of memory' }),
    err({ code: 'readiness_timeout' }),
    err({ message: 'some entirely unfamiliar failure' }),
    err({ message: 'D:/models/private/secret.gguf could not be opened' }),
  ]
  for (const e of inputs) {
    assert.ok(
      (FAIL_REASONS as readonly string[]).includes(classifyLoadFailure(e)),
      `classified value must be in the enum, got ${classifyLoadFailure(e)}`,
    )
  }
})

test('classifyLoadFailure: recognises CUDA out-of-memory', () => {
  assert.equal(classifyLoadFailure(err({ message: 'CUDA error: out of memory' })), 'oom')
})

test('classifyLoadFailure: finds OOM in the log tail, not just the message', () => {
  // llama.cpp usually reports the real cause in the log, with a generic exit
  // message — so a message-only classifier would report every OOM as "other".
  const e = err({ message: 'engine exited with code 1', logTail: ['ggml_backend_cuda_buffer_type_alloc_buffer: allocating 4096 MiB failed: out of memory'] })
  assert.equal(classifyLoadFailure(e), 'oom')
})

test('classifyLoadFailure: recognises the vendor variants of OOM', () => {
  assert.equal(classifyLoadFailure(err({ message: 'ggml_vulkan: Device memory allocation of size 123 failed' })), 'oom')
  assert.equal(classifyLoadFailure(err({ message: 'hipErrorOutOfMemory' })), 'oom')
  assert.equal(classifyLoadFailure(err({ message: 'failed to allocate buffer' })), 'oom')
})

test('classifyLoadFailure: a readiness timeout is a timeout', () => {
  assert.equal(classifyLoadFailure(err({ code: 'readiness_timeout' })), 'timeout')
})

test('classifyLoadFailure: a missing or unusable engine is no_engine', () => {
  assert.equal(classifyLoadFailure(err({ code: 'engine_unsupported' })), 'no_engine')
  assert.equal(classifyLoadFailure(err({ message: 'no_active_engine' })), 'no_engine')
})

test('classifyLoadFailure: an unknown architecture is reported as such', () => {
  assert.equal(
    classifyLoadFailure(err({ message: 'llama_model_load: error loading model: unknown model architecture: bitnet' })),
    'unsupported_arch',
  )
})

test('classifyLoadFailure: a corrupt or unreadable gguf is bad_gguf', () => {
  assert.equal(classifyLoadFailure(err({ message: 'invalid magic characters in gguf file' })), 'bad_gguf')
  assert.equal(classifyLoadFailure(err({ message: 'llama_model_load: error loading model' })), 'bad_gguf')
})

test('classifyLoadFailure: OOM wins over the generic load-failure text it accompanies', () => {
  // Real llama.cpp OOM output contains BOTH "error loading model" and the
  // allocation failure. Reporting it as bad_gguf would send us hunting a
  // corruption bug that does not exist.
  const e = err({ message: 'llama_model_load: error loading model: failed to allocate buffer' })
  assert.equal(classifyLoadFailure(e), 'oom')
})

test('classifyLoadFailure: anything unrecognised is other, not a guess', () => {
  assert.equal(classifyLoadFailure(err({ message: 'something nobody has seen before' })), 'other')
})

test('classifyLoadFailure: a null error still classifies', () => {
  assert.equal(classifyLoadFailure(null), 'other')
})

test('classifyBenchFailure: OOM wins when present, even alongside other outcomes', () => {
  // Auto-tune's binary search is EXPECTED to hit OOM on some candidates before
  // finding one that fits — OOM among the attempts is the dominant, actionable
  // explanation for why the sweep as a whole failed, same precedence
  // classifyLoadFailure already uses for a single raw error.
  assert.equal(classifyBenchFailure([{ outcome: 'oom' }, { outcome: 'crash' }, { outcome: 'timeout' }]), 'oom')
  assert.equal(classifyBenchFailure([{ outcome: 'oom' }]), 'oom')
})

test('classifyBenchFailure: timeout when present and no OOM', () => {
  assert.equal(classifyBenchFailure([{ outcome: 'crash' }, { outcome: 'timeout' }]), 'timeout')
})

test('classifyBenchFailure: a crash-only sweep is other, not a guess', () => {
  assert.equal(classifyBenchFailure([{ outcome: 'crash' }]), 'other')
})

test('classifyBenchFailure: no candidates at all is other', () => {
  assert.equal(classifyBenchFailure([]), 'other')
})

test('classifyBenchFailure: always returns a value from the enum', () => {
  for (const outcomes of [[{ outcome: 'oom' as const }], [{ outcome: 'crash' as const }], []]) {
    assert.ok((FAIL_REASONS as readonly string[]).includes(classifyBenchFailure(outcomes)))
  }
})

test('classifyLoadFailure: recognises the widened OOM/arch/corruption phrasings (telemetry-review follow-up)', () => {
  assert.equal(classifyLoadFailure(err({ message: 'std::bad_alloc' })), 'oom')
  assert.equal(classifyLoadFailure(err({ message: 'RuntimeError: CUDA_ERROR_OUT_OF_MEMORY' })), 'oom')
  assert.equal(classifyLoadFailure(err({ message: 'model architecture not supported: mamba2' })), 'unsupported_arch')
  assert.equal(classifyLoadFailure(err({ message: 'unexpectedly reached end of file' })), 'bad_gguf')
  assert.equal(classifyLoadFailure(err({ message: 'failed to read tensor blk.0.attn_q.weight' })), 'bad_gguf')
})

test('classifyEngineErrorFingerprint: always returns a value from the enum', () => {
  const inputs = [
    err({ message: 'CUDA error: out of memory' }),
    err({ code: 'readiness_timeout' }),
    err({ code: 'model_load_failed' }),
    err({ code: 'engine_exited' }),
    err({ code: 'engine_spawn_failed' }),
    err({ message: 'something nobody has seen before' }),
    null,
  ]
  for (const e of inputs) {
    assert.ok(
      (ERROR_FINGERPRINTS as readonly string[]).includes(classifyEngineErrorFingerprint(e)),
      `classified value must be in the enum, got ${classifyEngineErrorFingerprint(e)}`,
    )
  }
})

test('classifyEngineErrorFingerprint: maps OOM, timeout, and python load failures to their own fingerprints', () => {
  assert.equal(classifyEngineErrorFingerprint(err({ message: 'CUDA error: out of memory' })), 'cuda_oom')
  assert.equal(classifyEngineErrorFingerprint(err({ code: 'readiness_timeout' })), 'engine_start_timeout')
  assert.equal(classifyEngineErrorFingerprint(err({ code: 'model_load_failed', message: 'traceback...' })), 'model_load_failed')
  assert.equal(classifyEngineErrorFingerprint(err({ message: 'invalid magic characters in gguf file' })), 'model_load_failed')
})

test('classifyEngineErrorFingerprint: an unexplained process exit is engine_crash, not other', () => {
  // We DO know structurally that the process died — 'other' would under-describe it.
  assert.equal(classifyEngineErrorFingerprint(err({ code: 'engine_exited', message: 'The engine process exited unexpectedly.' })), 'engine_crash')
  assert.equal(classifyEngineErrorFingerprint(err({ code: 'engine_spawn_failed', message: 'ENOENT' })), 'engine_crash')
})

test('classifyEngineErrorFingerprint: a null error is other', () => {
  assert.equal(classifyEngineErrorFingerprint(null), 'other')
})

test('classifyProvisionFailure: always returns a value from the enum', () => {
  const inputs = [
    'TurboQuant has no prebuilt binary for this operating system in its latest release.',
    '404 fetching release asset',
    'Could not download a default engine. Check your connection or add one manually.',
    'ENOSPC: no space left on device',
    'EACCES: permission denied',
    'something nobody has seen before',
    null,
    undefined,
  ]
  for (const m of inputs) {
    assert.ok(
      (PROVISION_FAIL_REASONS as readonly string[]).includes(classifyProvisionFailure(m)),
      `classified value must be in the enum, got ${classifyProvisionFailure(m)}`,
    )
  }
})

test('classifyProvisionFailure: recognises real messages seen at ProvisionState.fail() call sites', () => {
  assert.equal(classifyProvisionFailure('TurboQuant has no prebuilt binary for this operating system in its latest release.'), 'unsupported_platform')
  assert.equal(classifyProvisionFailure('KoboldCpp has no prebuilt binary for this operating system/architecture in its latest release.'), 'unsupported_platform')
  assert.equal(classifyProvisionFailure('llamafile has no downloadable binary in its latest release.'), 'no_asset')
  assert.equal(classifyProvisionFailure('404 fetching release asset'), 'no_asset')
  assert.equal(classifyProvisionFailure('Could not download a default engine. Check your connection or add one manually.'), 'network')
  assert.equal(classifyProvisionFailure('Could not install the vulkan engine: fetch failed'), 'network')
  assert.equal(classifyProvisionFailure('Could not install the cuda engine: ENOSPC: no space left on device'), 'disk_full')
  assert.equal(classifyProvisionFailure('Could not install the cuda engine: EACCES: permission denied'), 'permission_denied')
})

test('classifyProvisionFailure: an unrecognised or missing message is other, not a guess', () => {
  assert.equal(classifyProvisionFailure('something nobody has seen before'), 'other')
  assert.equal(classifyProvisionFailure(null), 'other')
  assert.equal(classifyProvisionFailure(undefined), 'other')
})

test('classifyHarness: no header is unknown, not a guess', () => {
  assert.equal(classifyHarness(undefined), 'unknown')
  assert.equal(classifyHarness(null), 'unknown')
  assert.equal(classifyHarness(''), 'unknown')
})

test("classifyHarness: Claude Code's real UA prefix (spec 23 §3.5) maps to claude_code", () => {
  assert.equal(classifyHarness('claude-cli/1.2.3'), 'claude_code')
})

test('classifyHarness: is case-insensitive', () => {
  assert.equal(classifyHarness('Claude-CLI/1.2.3'), 'claude_code')
})

test('classifyHarness: recognises each documented CLI by its own name/library signature', () => {
  assert.equal(classifyHarness('opencode/0.1.0'), 'opencode')
  assert.equal(classifyHarness('KiloCode/1.0'), 'kilo')
  assert.equal(classifyHarness('hermes-agent/2.0'), 'hermes')
  assert.equal(classifyHarness('openclaw/1.0'), 'openclaw')
  assert.equal(classifyHarness('pi-coding-agent/1.0'), 'pi')
  assert.equal(classifyHarness('cline/3.0'), 'cline')
  assert.equal(classifyHarness('Roo-Code/1.0'), 'roo')
  assert.equal(classifyHarness('cursor/1.0'), 'cursor')
  // aider shells out through Python's litellm package — litellm/x.y.z is that
  // library's own default User-Agent, not a guess at aider's.
  assert.equal(classifyHarness('litellm/1.50.0'), 'aider')
  assert.equal(classifyHarness('Zed/0.150.0'), 'zed')
  assert.equal(classifyHarness('vscode-restclient'), 'vscode')
})

test('classifyHarness: an unrecognised client is other, not a guess', () => {
  assert.equal(classifyHarness('curl/8.0.1'), 'other')
  assert.equal(classifyHarness('PostmanRuntime/7.36.0'), 'other')
})

test('classifyHarness: always returns a value from the enum, for arbitrary/hostile input', () => {
  const inputs = ['', 'x'.repeat(5000), '<script>alert(1)</script>', ' ', 'CLAUDE-CLI/']
  for (const ua of inputs) {
    assert.ok(
      (HARNESSES as readonly string[]).includes(classifyHarness(ua)),
      `classified value must be in the enum, got ${classifyHarness(ua)}`,
    )
  }
})
