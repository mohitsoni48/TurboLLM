import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDirName, chooseEngineName, CMAKE_CONFIGURE_ARGS, isIncompleteMetalBackendError, pickGenerator, vcvarsBatch, stripGenericAsmLanguage, sameRepo, normRepoUrl, sourceBuildDirOf, notCmakeProjectError, missingPatchShaError, sha256Hex, patchChecksumMismatchError } from './build-runner'
import { join } from 'node:path'

test('buildDirName: owner/repo from a .git URL, branch appended', () => {
  assert.equal(buildDirName('https://github.com/ikawrakow/ik_llama.cpp.git', 'sidestream'), 'ikawrakow-ik_llama.cpp-sidestream')
})

test('buildDirName: no branch → bare owner/repo slug; trailing slash + .git stripped', () => {
  assert.equal(buildDirName('https://github.com/ggml-org/llama.cpp'), 'ggml-org-llama.cpp')
  assert.equal(buildDirName('https://github.com/ggml-org/llama.cpp.git/'), 'ggml-org-llama.cpp')
})

test('buildDirName: sanitizes unsafe chars in branch to single dashes', () => {
  assert.equal(buildDirName('https://github.com/owner/repo', 'feature/foo bar'), 'owner-repo-feature-foo-bar')
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
  assert.equal(pinned, 'atomicbot-ai-atomic-llama-cpp-turboquant-11a241d0db78')
  // commit takes priority over branch when both are set (same dir either way).
  assert.equal(pinnedWithBranch, pinned)
})

test('chooseEngineName: a freshly-submitted name ALWAYS wins over the prior registration (ADR-387 correction)', () => {
  // The actual "always names it Prism" bug on a REBUILD of the same repo: rebuilding
  // legitimately matches `prior`, and the old code kept prior.name unconditionally, discarding
  // whatever new name the user just typed.
  assert.equal(chooseEngineName('My New Name', 'Prism'), 'My New Name')
  assert.equal(chooseEngineName('Prism v2', 'Prism'), 'Prism v2')
})

test('chooseEngineName: falls back to the prior name only when no name was submitted at all', () => {
  assert.equal(chooseEngineName(undefined, 'Prism'), 'Prism')
})

test('chooseEngineName: a fresh build with neither a submitted nor a prior name is empty (registry.add derives one)', () => {
  assert.equal(chooseEngineName(undefined, undefined), '')
})

test('normRepoUrl: strips scheme, github.com host, .git suffix, trailing slash, and case', () => {
  assert.equal(normRepoUrl('https://github.com/GGML-org/Llama.cpp'), 'ggml-org/llama.cpp')
  assert.equal(normRepoUrl('https://github.com/ggml-org/llama.cpp.git'), 'ggml-org/llama.cpp')
  assert.equal(normRepoUrl('https://github.com/ggml-org/llama.cpp/'), 'ggml-org/llama.cpp')
})

test('normRepoUrl: a trailing slash AFTER ".git" still strips both (order-of-operations regression)', () => {
  // Found via the buildDirName fix above: stripping ".git$" before the trailing slash left
  // ".git" stranded whenever the URL ended ".git/" — two spellings of the same repo would then
  // compare unequal in sameRepo/customSourceKey, the exact bug class this file fixes.
  assert.equal(normRepoUrl('https://github.com/ggml-org/llama.cpp.git/'), 'ggml-org/llama.cpp')
  assert.equal(normRepoUrl('https://github.com/ggml-org/llama.cpp.git//'), 'ggml-org/llama.cpp')
})

test('buildDirName: two DIFFERENT forks that share the upstream repo NAME never collide (ADR-387 regression)', () => {
  // Countless llama.cpp forks keep the repo named "llama.cpp" and differ only by owner. Before
  // the fix, buildDirName slugged on the trailing URL segment alone, so these produced the
  // IDENTICAL directory — runBuild's clean-start rmSync would wipe one fork's build when the
  // other was built next, and routes.ts's binPath-based rebuild check would then inherit the
  // OLD engine's stored name for the NEW build no matter what name the user typed.
  const prism = buildDirName('https://github.com/PrismML-Eng/llama.cpp', 'prism')
  const upstream = buildDirName('https://github.com/ggml-org/llama.cpp')
  const anotherFork = buildDirName('https://github.com/someone-else/llama.cpp')
  assert.notEqual(prism, upstream)
  assert.notEqual(prism, anotherFork)
  assert.notEqual(upstream, anotherFork)
  assert.equal(prism, 'prismml-eng-llama.cpp-prism')
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

// ── Pinned-patch build (solar_open2-class engines) ───────────────────────────
// The load-bearing safety property: a build patch is applied ONLY after its downloaded bytes
// match a SHA-256 pinned in app code. runBuild() drives these three PURE helpers in order
// (guard → verify), so testing them proves the invariant without a real clone/fetch/compile:
//   1. missingPatchShaError — refuses a patchUrl with no pin, BEFORE any network call.
//   2. sha256Hex — the checksum the downloaded bytes are pinned against.
//   3. patchChecksumMismatchError — hard-fails a byte mismatch BEFORE git apply runs.

test('missingPatchShaError: a patch URL without a pinned checksum is refused', () => {
  const msg = missingPatchShaError('https://example.com/x.patch', undefined)
  assert.ok(msg && /pinned SHA-256/.test(msg))
  // whitespace-only checksum counts as absent
  assert.ok(missingPatchShaError('https://example.com/x.patch', '   '))
})

test('missingPatchShaError: null when no patch, or a patch WITH a checksum', () => {
  assert.equal(missingPatchShaError(undefined, undefined), null)
  assert.equal(missingPatchShaError('', 'deadbeef'), null) // no URL → nothing to apply
  assert.equal(missingPatchShaError('https://example.com/x.patch', 'deadbeef'), null)
})

test('sha256Hex: known vector (sha256 of "abc")', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('patchChecksumMismatchError: null when actual matches pinned (case-insensitive)', () => {
  const sha = sha256Hex(Buffer.from('abc'))
  assert.equal(patchChecksumMismatchError(sha, sha), null)
  assert.equal(patchChecksumMismatchError(sha.toUpperCase(), sha), null)
})

test('patchChecksumMismatchError: actionable hard-fail when bytes do not match the pin', () => {
  const pinned = sha256Hex(Buffer.from('the patch we vetted'))
  const actual = sha256Hex(Buffer.from('a mutated/compromised patch'))
  const msg = patchChecksumMismatchError(pinned, actual)
  assert.ok(msg && /did not match/.test(msg))
  assert.ok(msg && msg.includes(pinned.toLowerCase()) && msg.includes(actual.toLowerCase()))
  assert.ok(msg && /before any patch was applied/.test(msg))
})
