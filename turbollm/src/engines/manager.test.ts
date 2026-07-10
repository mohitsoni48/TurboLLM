import assert from 'node:assert/strict'
import { test } from 'node:test'
import { needsShellWrapper, shellWrapped } from './manager'

// Regression: llamafile ships as an "Actually Portable Executable" (Cosmopolitan libc) polyglot —
// spawning it directly via Node's execve()-based spawn() failed with ENOEXEC on macOS (confirmed
// live: the daemon accepted the start request but the process never actually spawned), while
// running the identical binary through a shell worked immediately. needsShellWrapper/shellWrapped
// fix this by routing llamafile through `/bin/sh -c 'exec "$0" "$@"'` on non-Windows platforms.

test('needsShellWrapper: true for llamafile on macOS/Linux', () => {
  const orig = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  try {
    assert.equal(needsShellWrapper('llamafile'), true)
  } finally {
    Object.defineProperty(process, 'platform', { value: orig })
  }
})

test('needsShellWrapper: false for llamafile on Windows (native MZ/PE header already works)', () => {
  const orig = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    assert.equal(needsShellWrapper('llamafile'), false)
  } finally {
    Object.defineProperty(process, 'platform', { value: orig })
  }
})

test('needsShellWrapper: false for every other engine kind', () => {
  for (const kind of ['llama-server', 'mlx', 'rapid-mlx', 'vllm', 'sglang', 'koboldcpp']) {
    assert.equal(needsShellWrapper(kind), false, `expected ${kind} to not need a shell wrapper`)
  }
})

test('shellWrapped: routes through /bin/sh with cmd/args as separate argv entries (no string concatenation)', () => {
  const { cmd, args } = shellWrapped('/path/to/llamafile', ['--server', '-m', '/path with spaces/model.gguf'])
  assert.equal(cmd, '/bin/sh')
  assert.deepEqual(args, ['-c', 'exec "$0" "$@"', '/path/to/llamafile', '--server', '-m', '/path with spaces/model.gguf'])
})
