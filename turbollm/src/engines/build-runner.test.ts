import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDirName, CMAKE_CONFIGURE_ARGS, isIncompleteMetalBackendError, pickGenerator, vcvarsBatch, stripGenericAsmLanguage, sameRepo, sourceBuildDirOf, notCmakeProjectError } from './build-runner'
import { join } from 'node:path'

test('buildDirName: repo name from a .git URL, branch appended', () => {
  assert.equal(buildDirName('https://github.com/ikawrakow/ik_llama.cpp.git', 'sidestream'), 'ik_llama.cpp-sidestream')
})

test('buildDirName: no branch → bare repo name; trailing slash + .git stripped', () => {
  assert.equal(buildDirName('https://github.com/ggml-org/llama.cpp'), 'llama.cpp')
  assert.equal(buildDirName('https://github.com/ggml-org/llama.cpp.git/'), 'llama.cpp')
})

test('buildDirName: sanitizes unsafe chars in branch to single dashes', () => {
  assert.equal(buildDirName('https://github.com/owner/repo', 'feature/foo bar'), 'repo-feature-foo-bar')
})

test('buildDirName: unparseable URL falls back to "engine"', () => {
  assert.equal(buildDirName(''), 'engine')
  assert.equal(buildDirName('   '), 'engine')
})

test('buildDirName: a pinned commit gets its OWN dir, never the same as a plain branch build', () => {
  // Safety-critical: runBuild() rmSync's buildRoot at the start of every run. If a
  // commit-pinned build ever collapsed to the same dir as the plain repo/branch build, it
  // would silently wipe an existing (possibly currently-installed) engine build.
  const repo = 'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant'
  const plain = buildDirName(repo)
  const branched = buildDirName(repo, 'feature/turboquant-kv-cache')
  const pinned = buildDirName(repo, undefined, '11a241d0db78a68e0a5b99fe6f36de6683100f6a')
  const pinnedWithBranch = buildDirName(repo, 'feature/turboquant-kv-cache', '11a241d0db78a68e0a5b99fe6f36de6683100f6a')
  assert.notEqual(pinned, plain)
  assert.notEqual(pinned, branched)
  assert.equal(pinned, 'atomic-llama-cpp-turboquant-11a241d0db78')
  // commit takes priority over branch when both are set (same dir either way).
  assert.equal(pinnedWithBranch, pinned)
})

test('CMAKE_CONFIGURE_ARGS: enables CUDA + Release, allows an unrecognized-but-newer host compiler', () => {
  assert.deepEqual(CMAKE_CONFIGURE_ARGS, [
    '-DGGML_CUDA=ON',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler',
  ])
})

test('pickGenerator: Ninja when available regardless of platform', () => {
  assert.equal(pickGenerator(true, true), 'Ninja')
  assert.equal(pickGenerator(true, false), 'Ninja')
})

test('pickGenerator: falls back to NMake on Windows, Unix Makefiles on Linux', () => {
  assert.equal(pickGenerator(false, true), 'NMake Makefiles')
  assert.equal(pickGenerator(false, false), 'Unix Makefiles')
})

// Regression: ik_llama.cpp on macOS references ggml_backend_is_metal / ggml_backend_metal_set_n_cb
// in its own src/llama-dflash.cpp, but its vendored ggml doesn't implement them (its own catalog
// note says "CPU + CUDA only, no ROCm/Metal") — the guided build should detect this specific
// clang error and retry CPU-only rather than just failing.
test('isIncompleteMetalBackendError: detects the real ik_llama.cpp clang error', () => {
  const log = [
    "/path/src/llama-dflash.cpp:204:9: error: use of undeclared identifier 'ggml_backend_is_metal'; did you mean 'ggml_backend_is_cpu'?",
    "/path/src/llama-dflash.cpp:205:9: error: use of undeclared identifier 'ggml_backend_metal_set_n_cb'",
    'make[3]: *** [src/CMakeFiles/llama.dir/llama-dflash.cpp.o] Error 1',
  ]
  assert.equal(isIncompleteMetalBackendError(log), true)
})

test('isIncompleteMetalBackendError: false for an unrelated compile error', () => {
  const log = [
    "error: use of undeclared identifier 'foo_bar_baz'",
    'make[3]: *** [src/CMakeFiles/llama.dir/some-file.cpp.o] Error 1',
  ]
  assert.equal(isIncompleteMetalBackendError(log), false)
})

test('isIncompleteMetalBackendError: false for an empty/successful log', () => {
  assert.equal(isIncompleteMetalBackendError([]), false)
})

test('vcvarsBatch: calls vcvars x64, then cmake, quotes spaced args, propagates exit code', () => {
  const bat = vcvarsBatch('C:\\Program Files\\VC\\vcvarsall.bat', ['-G', 'NMake Makefiles', '-B', 'C:\\b dir'])
  const lines = bat.split('\r\n')
  assert.equal(lines[0], '@echo off')
  assert.equal(lines[1], 'call "C:\\Program Files\\VC\\vcvarsall.bat" x64')
  assert.equal(lines[2], 'if errorlevel 1 exit /b 1')
  // spaced args quoted, unspaced left bare
  assert.equal(lines[3], 'cmake -G "NMake Makefiles" -B "C:\\b dir"')
  assert.equal(lines[4], 'exit /b %errorlevel%')
})

test('vcvarsBatch: leaves space-free args unquoted', () => {
  const bat = vcvarsBatch('C:\\vc.bat', ['-G', 'Ninja', '-DGGML_CUDA=ON'])
  assert.ok(bat.includes('cmake -G Ninja -DGGML_CUDA=ON'))
})

test('stripGenericAsmLanguage: removes ASM from a project() language list (TurboQuant case)', () => {
  const { text, changed } = stripGenericAsmLanguage('project("ggml" C CXX ASM)\nset(X 1)')
  assert.equal(changed, true)
  assert.match(text, /project\("ggml" C CXX\)/)
  assert.ok(!/\bASM\b/.test(text))
})

test('stripGenericAsmLanguage: handles unquoted project name + extra spacing', () => {
  const { text } = stripGenericAsmLanguage('project(ggml-htp C CXX ASM)')
  assert.equal(text, 'project(ggml-htp C CXX)')
})

test('stripGenericAsmLanguage: comments out a standalone enable_language(ASM)', () => {
  const { text, changed } = stripGenericAsmLanguage('    enable_language(ASM)')
  assert.equal(changed, true)
  assert.match(text, /^#\s+enable_language\(ASM\)/)
})

test('stripGenericAsmLanguage: leaves CMake without ASM untouched', () => {
  const src = 'project("ggml" C CXX)\nenable_language(CUDA)\n'
  const { text, changed } = stripGenericAsmLanguage(src)
  assert.equal(changed, false)
  assert.equal(text, src)
})

test('stripGenericAsmLanguage: does not touch unrelated tokens containing the letters ASM', () => {
  const { text, changed } = stripGenericAsmLanguage('set(MY_WASM_FLAG ON)')
  assert.equal(changed, false)
  assert.ok(text.includes('MY_WASM_FLAG'))
})

test('sameRepo: matches a homepage URL to a stored sourceRepo regardless of scheme/.git/case', () => {
  assert.ok(sameRepo('https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant', 'https://github.com/atomicbot-ai/atomic-llama-cpp-turboquant'))
  assert.ok(sameRepo('https://github.com/owner/repo', 'owner/repo'))
  assert.ok(sameRepo('https://github.com/owner/repo.git', 'https://github.com/owner/repo/'))
})

test('sameRepo: distinct repos do not match; empty never matches', () => {
  assert.ok(!sameRepo('https://github.com/owner/repo-a', 'https://github.com/owner/repo-b'))
  assert.ok(!sameRepo('', 'owner/repo'))
  assert.ok(!sameRepo(undefined, undefined))
})

test('sourceBuildDirOf: derives the build dir from a source-built binPath', () => {
  const root = join('C:', 'Users', 'x', '.turbollm', 'engines')
  const bin = join(root, 'build', 'atomic-llama-cpp-turboquant', 'build', 'bin', 'llama-server.exe')
  assert.equal(sourceBuildDirOf(bin, root), join(root, 'build', 'atomic-llama-cpp-turboquant'))
})

test('sourceBuildDirOf: null for a non-source-build binary path', () => {
  const root = join('C:', 'e')
  assert.equal(sourceBuildDirOf(join(root, 'turboquant', 'llama-server.exe'), root), null)
})

// GitHub #61: exllamav3 (a pure-Python engine, no CMakeLists.txt) failed 1-click build with a
// bare "cmake exited with code 1" and no explanation. notCmakeProjectError fails fast instead.
test('notCmakeProjectError: null (no error) when CMakeLists.txt is present', () => {
  assert.equal(notCmakeProjectError(true), null)
})

test('notCmakeProjectError: actionable message when CMakeLists.txt is absent', () => {
  const msg = notCmakeProjectError(false)
  assert.ok(msg && /CMakeLists\.txt/.test(msg))
  assert.ok(msg && /llama\.cpp/.test(msg))
})
