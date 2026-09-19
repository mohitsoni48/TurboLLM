import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDirName, chooseEngineName, CMAKE_CONFIGURE_ARGS, isIncompleteMetalBackendError, pickGenerator, vcvarsBatch, stripGenericAsmLanguage, sameRepo, normRepoUrl, sourceBuildDirOf, notCmakeProjectError, missingPatchShaError, sha256Hex, patchChecksumMismatchError, findPriorEngine, parseDefaultBranch, findEngineForCatalogEntry, catalogBranchesToScan, legacyBuildDirName, findCatalogBuildOnDisk, findNameConflict, isEngineInBuildDir } from './build-runner'
import { join, relative } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

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

test('findPriorEngine: matches by exact binPath (the common rebuild case)', () => {
  const engines = [{ id: '1', name: 'Prism', binPath: '/data/engines/build/owner-repo/llama-server' }]
  const prior = findPriorEngine(engines, { binPath: '/data/engines/build/owner-repo/llama-server' })
  assert.equal(prior?.id, '1')
})

test('findPriorEngine: matches by repo identity even when the URL spelling differs (regression, ADR-387 follow-up)', () => {
  // ADR-387 fixed buildDirName's own repo comparison but explicitly flagged this exact class of
  // bug as unaddressed at this OTHER call site: "registration still matches by binary path before
  // checking repo identity ... a future collision class would reopen the same failure shape."
  // A moved data dir (ADR-215) changes the absolute binPath even though repo+branch+commit are
  // unchanged, and a raw `===` on sourceRepo then fails to see two spellings of the same repo as
  // the same repo — leaving the old registration (and its name) stranded forever.
  const engines = [
    {
      id: '1',
      name: 'ik-llama',
      binPath: '/old/data/dir/engines/build/ikawrakow-ik_llama.cpp/llama-server',
      sourceRepo: 'https://github.com/ikawrakow/ik_llama.cpp.git/',
      sourceBranch: 'main',
      sourceCommit: '',
    },
  ]
  const prior = findPriorEngine(engines, {
    binPath: '/new/data/dir/engines/build/ikawrakow-ik_llama.cpp/llama-server',
    sourceRepo: 'https://github.com/ikawrakow/ik_llama.cpp',
    sourceBranch: 'main',
    sourceCommit: '',
  })
  assert.equal(prior?.id, '1')
})

test('findPriorEngine: a commit-pinned build never matches a plain branch-tip build of the same repo, or vice versa', () => {
  const engines = [
    { id: '1', name: 'Prism', binPath: '/x/branch-build', sourceRepo: 'https://github.com/o/r', sourceBranch: 'main', sourceCommit: '' },
  ]
  const prior = findPriorEngine(engines, {
    binPath: '/x/pinned-build',
    sourceRepo: 'https://github.com/o/r',
    sourceBranch: 'main',
    sourceCommit: 'abc123',
  })
  assert.equal(prior, undefined)
})

test('findPriorEngine: an unrelated repo never matches', () => {
  const engines = [{ id: '1', name: 'Other', binPath: '/x/other', sourceRepo: 'https://github.com/a/b' }]
  const prior = findPriorEngine(engines, { binPath: '/x/new', sourceRepo: 'https://github.com/c/d' })
  assert.equal(prior, undefined)
})

const IK_REPO = 'https://github.com/ikawrakow/ik_llama.cpp'
const blankBranchEngine = {
  id: '1',
  name: 'ik_llama.cpp',
  binPath: 'C:\\...\\build\\ikawrakow-ik_llama.cpp\\build\\bin\\llama-server.exe',
  sourceRepo: IK_REPO,
  sourceCommit: '',
}

test('findPriorEngine: a blank branch matches a later build that names the repo default explicitly (live-reproduced regression)', () => {
  // Reproduced live: "Add via git repo" leaves branch blank ("leave blank to build the repo's own
  // default branch" — CustomBuildDialog.tsx) and registers with sourceBranch undefined, landing at
  // the bare buildDirName (no branch suffix). The SAME engine's own "Rebuild" action later sends an
  // EXPLICIT branch (EnginesScreen.tsx's selectedBranch, initialized from catalog.defaultBranch —
  // "main" for ik_llama.cpp), which slugs to a DIFFERENT directory/binPath. Neither the binPath
  // check nor an exact branch comparison sees these as the same target, so the stale registration
  // is never replaced and blocks the rebuild's name with NameTakenError forever.
  const prior = findPriorEngine([blankBranchEngine], {
    binPath: 'C:\\...\\build\\ikawrakow-ik_llama.cpp-main\\build\\bin\\llama-server.exe',
    sourceRepo: IK_REPO,
    sourceBranch: 'main',
    sourceCommit: '',
    defaultBranch: 'main',
  })
  assert.equal(prior?.id, '1')
})

test('findPriorEngine: a blank-branch registration is NOT replaced by a build of a DIFFERENT branch (Opus review, destructive)', () => {
  // The first version of this fix bridged a blank branch to ANY named branch, so adding a second
  // engine from another branch of the same repo silently deleted the first. "Blank" means the
  // repo's DEFAULT branch — a build of any other branch is a distinct engine that must coexist.
  const prior = findPriorEngine([blankBranchEngine], {
    binPath: '/x/ikawrakow-ik_llama.cpp-sidestream/llama-server',
    sourceRepo: IK_REPO,
    sourceBranch: 'sidestream',
    sourceCommit: '',
    defaultBranch: 'main',
  })
  assert.equal(prior, undefined)
})

test('findPriorEngine: a blank new build matches an engine already registered under the resolved default branch', () => {
  const namedMain = { id: '2', name: 'ik', binPath: '/x/named-main', sourceRepo: IK_REPO, sourceBranch: 'main', sourceCommit: '' }
  const prior = findPriorEngine([namedMain], { binPath: '/x/new', sourceRepo: IK_REPO, sourceCommit: '', defaultBranch: 'main' })
  assert.equal(prior?.id, '2')
})

test('findPriorEngine: never bridges blank to named when the default branch could not be resolved', () => {
  // Fail closed: with no way to know that "main" is the default, treating the two as the same
  // engine is a guess, and a wrong guess deletes a registration. Falls through to no match.
  const prior = findPriorEngine([blankBranchEngine], {
    binPath: '/x/new',
    sourceRepo: IK_REPO,
    sourceBranch: 'main',
    sourceCommit: '',
  })
  assert.equal(prior, undefined)
})

test('findPriorEngine: with several branches tracked, only the one matching the build\'s effective branch is replaced', () => {
  const dev = { id: '3', name: 'fork-dev', binPath: '/x/dev', sourceRepo: IK_REPO, sourceBranch: 'dev', sourceCommit: '' }
  const prior = findPriorEngine([dev, blankBranchEngine], {
    binPath: '/x/new',
    sourceRepo: IK_REPO,
    sourceBranch: 'main',
    sourceCommit: '',
    defaultBranch: 'main',
  })
  assert.equal(prior?.id, '1')
})

test('findPriorEngine: a blank AND an explicitly-named-default registration — the exact branch match wins, whatever the registry order (Opus pass 2)', () => {
  // Both resolve to "main", so both are candidates. Picking by array position left the other one
  // holding the name, which then failed the registration with NameTakenError AND deleted an engine
  // the build was not aimed at. An exact stored-branch match is the more specific claim.
  const named = { id: '2', name: 'ik-named', binPath: '/x/named', sourceRepo: IK_REPO, sourceBranch: 'main', sourceCommit: '' }
  const build = { binPath: '/x/new', sourceRepo: IK_REPO, sourceBranch: 'main', sourceCommit: '', defaultBranch: 'main' }
  assert.equal(findPriorEngine([blankBranchEngine, named], build)?.id, '2')
  assert.equal(findPriorEngine([named, blankBranchEngine], build)?.id, '2')
  const blankBuild = { binPath: '/x/new', sourceRepo: IK_REPO, sourceCommit: '', defaultBranch: 'main' }
  assert.equal(findPriorEngine([named, blankBranchEngine], blankBuild)?.id, '1')
})

const PRISM_HOME = 'https://github.com/PrismML-Eng/llama.cpp'
const prismCard = { homepage: PRISM_HOME, defaultBranch: 'prism' }
const registered = (id: string, sourceBranch?: string, extra: Record<string, string> = {}) => ({
  id,
  name: id,
  binPath: `/x/${id}`,
  sourceRepo: PRISM_HOME,
  sourceBranch,
  sourceCommit: '',
  ...extra,
})

test('findEngineForCatalogEntry: a card finds the engine it built on the default branch (live-reproduced orphan)', () => {
  // Reproduced live after a real Prism build: the engine registered as sourceBranch "prism", but the
  // catalog matched by EXACT recorded branch against a request that never carries one (''), so the
  // Prism card reported sourceBuilt:false and could not manage its own engine.
  assert.equal(findEngineForCatalogEntry([registered('built', 'prism')], prismCard)?.id, 'built')
})

test('findEngineForCatalogEntry: a blank-branch (legacy / Add via git repo) registration still belongs to the card', () => {
  assert.equal(findEngineForCatalogEntry([registered('legacy')], prismCard)?.id, 'legacy')
})

test('findEngineForCatalogEntry: an engine on a DIFFERENT branch is not the default card\'s engine', () => {
  assert.equal(findEngineForCatalogEntry([registered('other', 'sidestream')], prismCard), undefined)
})

test('findEngineForCatalogEntry: an exact recorded-branch match beats a blank one, whatever the registry order', () => {
  const blank = registered('blank')
  const named = registered('named', 'prism')
  assert.equal(findEngineForCatalogEntry([blank, named], prismCard)?.id, 'named')
  assert.equal(findEngineForCatalogEntry([named, blank], prismCard)?.id, 'named')
})

test('findEngineForCatalogEntry: an explicitly requested branch finds that branch\'s engine only', () => {
  const engines = [registered('default', 'prism'), registered('dev', 'dev')]
  assert.equal(findEngineForCatalogEntry(engines, prismCard, 'dev')?.id, 'dev')
})

test('findEngineForCatalogEntry: a pinned-commit entry ignores the recorded branch (the commit is the identity)', () => {
  const pinnedCard = { homepage: PRISM_HOME, sourceCommit: '846e991ec3c7', patchUrl: 'https://x/p.diff' }
  const guessed = registered('pinned', 'main', { sourceCommit: '846e991ec3c7', sourcePatchUrl: 'https://x/p.diff' })
  assert.equal(findEngineForCatalogEntry([guessed], pinnedCard)?.id, 'pinned')
})

test('findEngineForCatalogEntry: a different repo, or a different pinned commit, never matches', () => {
  assert.equal(findEngineForCatalogEntry([{ ...registered('x', 'prism'), sourceRepo: 'https://github.com/a/b' }], prismCard), undefined)
  const pinnedCard = { homepage: PRISM_HOME, sourceCommit: 'aaaa1111', patchUrl: 'https://x/p.diff' }
  assert.equal(findEngineForCatalogEntry([registered('old', undefined, { sourceCommit: 'bbbb2222', sourcePatchUrl: 'https://x/p.diff' })], pinnedCard), undefined)
})

test('catalogBranchesToScan: the default branch first, then the legacy blank dir', () => {
  assert.deepEqual(catalogBranchesToScan({ defaultBranch: 'prism' }), ['prism', undefined])
  assert.deepEqual(catalogBranchesToScan({}), [undefined])
  assert.deepEqual(catalogBranchesToScan({ sourceCommit: 'abc' }), [undefined])
})

test('catalogBranchesToScan: a non-default branch never scans the default branch\'s (bare) directory (Opus review)', () => {
  // The bare directory is the DEFAULT branch's legacy build. Scanning it for `dev` would mark the
  // card installed from a different branch's binary, contradicting findEngineForCatalogEntry.
  assert.deepEqual(catalogBranchesToScan({ defaultBranch: 'prism' }, 'dev'), ['dev'])
  assert.deepEqual(catalogBranchesToScan({ defaultBranch: 'prism' }, 'prism'), ['prism', undefined])
})

test('findEngineForCatalogEntry: a stray space around the catalog default cannot break the match (Opus review)', () => {
  assert.equal(findEngineForCatalogEntry([registered('built', 'prism')], { homepage: PRISM_HOME, defaultBranch: ' prism ' })?.id, 'built')
})

test('parseDefaultBranch: reads the branch out of `git ls-remote --symref <url> HEAD` output', () => {
  const out = 'ref: refs/heads/main\tHEAD\n4c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d\tHEAD\n'
  assert.equal(parseDefaultBranch(out), 'main')
  assert.equal(parseDefaultBranch('ref: refs/heads/feature/x-y\tHEAD\nabc\tHEAD'), 'feature/x-y')
})

test('parseDefaultBranch: undefined when there is no symref line (empty repo, detached, garbage)', () => {
  assert.equal(parseDefaultBranch(''), undefined)
  assert.equal(parseDefaultBranch('4c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d\tHEAD\n'), undefined)
  assert.equal(parseDefaultBranch('fatal: unable to access'), undefined)
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

// ── ADR-431 follow-ups ──────────────────────────────────────────────────────

const serverExe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

function withEnginesRoot(dirs: string[], body: (enginesRoot: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'tllm-engines-'))
  try {
    for (const dir of dirs) {
      const bin = join(root, 'build', dir, 'build', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, serverExe), '')
    }
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('legacyBuildDirName: the pre-ADR-387 scheme slugged only the trailing URL segment', () => {
  const sha = '846e991ec3c7ccec49112ff2c5b00b710e5f551d'
  assert.equal(legacyBuildDirName('https://github.com/ggml-org/llama.cpp', undefined, sha), 'llama.cpp-846e991ec3c7')
  assert.equal(legacyBuildDirName('https://github.com/ggml-org/llama.cpp.git/', undefined, sha), 'llama.cpp-846e991ec3c7')
  assert.equal(legacyBuildDirName('https://github.com/PrismML-Eng/llama.cpp', 'prism'), 'llama.cpp-prism')
  assert.equal(legacyBuildDirName('https://github.com/o/repo'), 'repo')
})

const PRISM_ENTRY = { homepage: 'https://github.com/PrismML-Eng/llama.cpp', defaultBranch: 'prism' }

test('findCatalogBuildOnDisk: a card-built (named-branch) build is found and reports its branch', () => {
  withEnginesRoot(['prismml-eng-llama.cpp-prism'], (root) => {
    const found = findCatalogBuildOnDisk(root, PRISM_ENTRY)
    assert.equal(found?.branch, 'prism')
    assert.match(found?.binPath ?? '', /prismml-eng-llama\.cpp-prism/)
  })
})

test('findCatalogBuildOnDisk: a blank-branch (bare directory) build is found with a blank branch', () => {
  withEnginesRoot(['prismml-eng-llama.cpp'], (root) => {
    assert.equal(findCatalogBuildOnDisk(root, PRISM_ENTRY)?.branch, '')
  })
})

test('findCatalogBuildOnDisk: the named-branch build wins over the bare one', () => {
  withEnginesRoot(['prismml-eng-llama.cpp', 'prismml-eng-llama.cpp-prism'], (root) => {
    assert.equal(findCatalogBuildOnDisk(root, PRISM_ENTRY)?.branch, 'prism')
  })
})

test('findCatalogBuildOnDisk: nothing on disk means undefined', () => {
  withEnginesRoot([], (root) => assert.equal(findCatalogBuildOnDisk(root, PRISM_ENTRY), undefined))
})

test("findCatalogBuildOnDisk: a non-default branch never picks up the default branch's bare directory", () => {
  withEnginesRoot(['prismml-eng-llama.cpp'], (root) => {
    assert.equal(findCatalogBuildOnDisk(root, PRISM_ENTRY, 'dev'), undefined)
  })
})

const SOLAR_ENTRY = { homepage: 'https://github.com/ggml-org/llama.cpp', sourceCommit: '846e991ec3c7ccec49112ff2c5b00b710e5f551d', patchUrl: 'https://x/p.diff' }

test('findCatalogBuildOnDisk: a commit-pinned entry still finds a build made under the pre-ADR-387 directory name', () => {
  // Solar Open 2's real build lives at engines/build/llama.cpp-846e991ec3c7. A Disabled one would
  // otherwise read as "not installed" and offer a full rebuild over the top of good files.
  withEnginesRoot(['llama.cpp-846e991ec3c7'], (root) => {
    assert.match(findCatalogBuildOnDisk(root, SOLAR_ENTRY)?.binPath ?? '', /llama\.cpp-846e991ec3c7/)
  })
})

test('findCatalogBuildOnDisk: the current directory name wins over the legacy one for a pinned entry', () => {
  withEnginesRoot(['llama.cpp-846e991ec3c7', 'ggml-org-llama.cpp-846e991ec3c7'], (root) => {
    assert.match(findCatalogBuildOnDisk(root, SOLAR_ENTRY)?.binPath ?? '', /ggml-org-llama\.cpp-846e991ec3c7/)
  })
})

test('findCatalogBuildOnDisk: an UNPINNED entry never falls back to a legacy directory (any fork used that name)', () => {
  // The pre-ADR-387 slug dropped the owner, so 'llama.cpp' could be ANY fork's build. Only a pinned
  // commit is specific enough to trust.
  withEnginesRoot(['llama.cpp'], (root) => {
    assert.equal(findCatalogBuildOnDisk(root, { homepage: 'https://github.com/ggml-org/llama.cpp', defaultBranch: 'master' }), undefined)
  })
})

const BUILD_ROOT = '/data/engines/build/prismml-eng-llama.cpp-prism'
const holderOf = (over: Record<string, string | undefined> = {}) => ({
  id: 'h',
  name: 'Prism',
  binPath: '/data/engines/prebuilt/llama-server',
  sourceRepo: undefined as string | undefined,
  sourceBranch: undefined as string | undefined,
  sourceCommit: '',
  ...over,
})
const buildOf = (over: Record<string, string | undefined> = {}) => ({
  buildRoot: BUILD_ROOT,
  sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp',
  sourceBranch: 'prism' as string | undefined,
  sourceCommit: '',
  ...over,
})

test('findNameConflict: an unrelated engine holding the name is a certain conflict', () => {
  assert.equal(findNameConflict([holderOf()], 'Prism', buildOf())?.id, 'h')
})

test('findNameConflict: the name match is case-insensitive and trimmed, like the registry', () => {
  assert.equal(findNameConflict([holderOf({ name: '  PRISM ' })], 'prism', buildOf())?.id, 'h')
})

test('findNameConflict: the engine this build will REPLACE is not a conflict (its files live in the build dir)', () => {
  const inDir = holderOf({ binPath: BUILD_ROOT + '/build/bin/llama-server' })
  assert.equal(findNameConflict([inDir], 'Prism', buildOf()), undefined)
})

test('findNameConflict: the same repo and branch will be replaced, so it is not a conflict', () => {
  const same = holderOf({ sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp.git', sourceBranch: 'prism' })
  assert.equal(findNameConflict([same], 'Prism', buildOf()), undefined)
})

test('findNameConflict: a blank branch on either side is unknown, so never a certain conflict', () => {
  const blank = holderOf({ sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp', sourceBranch: '' })
  assert.equal(findNameConflict([blank], 'Prism', buildOf()), undefined)
  const named = holderOf({ sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp', sourceBranch: 'prism' })
  assert.equal(findNameConflict([named], 'Prism', buildOf({ sourceBranch: undefined })), undefined)
})

test('findNameConflict: the same repo on a DIFFERENT explicit branch is a certain conflict (the non-default-branch rebuild)', () => {
  const other = holderOf({ sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp', sourceBranch: 'main' })
  assert.equal(findNameConflict([other], 'Prism', buildOf())?.id, 'h')
})

test('findNameConflict: a commit-pinned and a branch-tip build of one repo never replace each other', () => {
  const pinned = holderOf({ sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp', sourceBranch: 'prism', sourceCommit: 'abc123' })
  assert.equal(findNameConflict([pinned], 'Prism', buildOf())?.id, 'h')
})

test('findNameConflict: no submitted name, or a free name, is never a conflict', () => {
  assert.equal(findNameConflict([holderOf()], undefined, buildOf()), undefined)
  assert.equal(findNameConflict([holderOf()], '   ', buildOf()), undefined)
  assert.equal(findNameConflict([holderOf()], 'Something else', buildOf()), undefined)
})

test('isEngineInBuildDir: true only for a binary under that build directory, whatever the separators or case', () => {
  assert.equal(isEngineInBuildDir(BUILD_ROOT + '/build/bin/llama-server', BUILD_ROOT), true)
  assert.equal(isEngineInBuildDir('\\DATA\\ENGINES\\BUILD\\PRISMML-ENG-LLAMA.CPP-PRISM\\BUILD\\BIN\\LLAMA-SERVER.EXE', BUILD_ROOT), true)
  assert.equal(isEngineInBuildDir(BUILD_ROOT + '-dev/build/bin/llama-server', BUILD_ROOT), false)
  assert.equal(isEngineInBuildDir('/data/engines/llama.cpp-b10970-cuda/llama-server', BUILD_ROOT), false)
})

// runBuild() rmSync's `<engines>/build/<dirName>` recursively before every clone. A dir name of
// ".." resolves to the engines root itself, so a repo URL ending in a dot segment used to be enough
// to delete every installed engine with one POST to /api/v1/build/run.
const HOSTILE_REPO_URLS = ['https://..', 'https://github.com/..', 'https://github.com/./', 'https://github.com/../', 'https://github.com/x/../..', '..', '.', '...', 'https://github.com/-..', '/..', '\\..']

// A name is safe when joining it under build/ lands exactly one level down, on itself. ".." lands on
// the engines root and "x/.." on build/ itself; a name that merely STARTS with dots ("..-..") is fine.
function isStrictChildOfBuildDir(dirName: string): boolean {
  const buildDir = join(tmpdir(), 'engines', 'build')
  return dirName !== '' && dirName !== '.' && dirName !== '..' && relative(buildDir, join(buildDir, dirName)) === dirName
}

test('buildDirName: no repo URL, however hostile, can name a directory outside <engines>/build/<slug>', () => {
  for (const url of HOSTILE_REPO_URLS) {
    for (const [branch, commit] of [[undefined, undefined], ['..', undefined], ['main', '..'], [undefined, '../../x']] as const) {
      const dir = buildDirName(url, branch, commit)
      assert.ok(isStrictChildOfBuildDir(dir), `buildDirName(${JSON.stringify(url)}, ${branch}, ${commit}) = ${JSON.stringify(dir)} escapes the build directory`)
    }
  }
})

test('legacyBuildDirName: the pre-ADR-387 scheme is bounded the same way (it is used to look up, never to delete, but must not be a path either)', () => {
  for (const url of HOSTILE_REPO_URLS) {
    const dir = legacyBuildDirName(url)
    assert.ok(isStrictChildOfBuildDir(dir), `legacyBuildDirName(${JSON.stringify(url)}) = ${JSON.stringify(dir)} escapes the build directory`)
  }
})

test('buildDirName: ordinary URLs keep their existing names (no build directory on disk is renamed by the guard)', () => {
  assert.equal(buildDirName('https://github.com/PrismML-Eng/llama.cpp', 'prism'), 'prismml-eng-llama.cpp-prism')
  assert.equal(buildDirName('https://github.com/ggml-org/llama.cpp'), 'ggml-org-llama.cpp')
  assert.equal(buildDirName('https://gitlab.com/group/sub.repo'), 'gitlab.com-group-sub.repo')
})
