import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDirName, chooseEngineName, CMAKE_CONFIGURE_ARGS, isIncompleteMetalBackendError, pickGenerator, vcvarsBatch, stripGenericAsmLanguage, sameRepo, normRepoUrl, sourceBuildDirOf, notCmakeProjectError, missingPatchShaError, sha256Hex, patchChecksumMismatchError, findPriorEngine, parseDefaultBranch, findEngineForCatalogEntry, catalogBranchesToScan, legacyBuildDirName, findCatalogBuildOnDisk, findNameConflict, isEngineInBuildDir } from './build-runner'
import { basename, delimiter, join, relative } from 'node:path'
import fs, { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import childProcess from 'node:child_process'
import { tmpDir } from '../test-support/tmp'
import { BUILD_INCOMPLETE_MARKER, copyCudaRuntimeLibs, discardParkedBuild, restoreInterruptedBuilds, runBuild, runPrereqInstall, runStep } from './build-runner'
import { checkBuildPrereqs } from './build-prereqs'

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

// A registered engine's binPath is stored exactly as typed (path.join would have collapsed the dot
// segments, so these are raw strings). `?purge=1` deletes whatever this returns recursively:
// "." made it the whole build/ directory (every source build), ".." the engines root itself.
test('sourceBuildDirOf: a dot segment in the binPath never selects build/ itself or its parent', () => {
  const root = join('C:', 'e', 'engines')
  for (const step of ['.', '..', '...']) {
    const bin = `C:/e/engines/build/${step}/prism/build/bin/llama-server.exe`
    assert.equal(sourceBuildDirOf(bin, root), null, `"${step}" must not resolve to a directory to delete`)
  }
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
  const root = tmpDir('tllm-engines-')
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
  const buildDir = '/data/engines/build'
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

// ── A rebuild that fails or is cancelled keeps the build it was replacing ───────────────────────
// A rebuild of the same repo+branch lands in the directory the registered engine runs from. It used
// to be rmSync'd before the clone, so an offline clone, an upstream tip that no longer compiles or a
// Cancel left the registry pointing at a binary that no longer existed.
for (const how of ['fails', 'is cancelled'] as const) {
  test(`runBuild: a rebuild that ${how} puts the previous build back and leaves nothing parked`, async (t) => {
    if (process.platform === 'win32') return t.skip('the Windows build needs the MSVC environment')
    const dir = tmpDir('tllm-rebuild-')
    const fakeBin = join(dir, 'fakebin')
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'nvcc'), '#!/bin/sh\necho "Cuda compilation tools, release 12.6, V12.6.20"\n', { mode: 0o755 })
    const prereqs = await checkBuildPrereqs([fakeBin])
    if (!prereqs.supported || prereqs.tools.some((x) => ['git', 'cmake', 'gcc'].includes(x.id) && !x.found))
      return t.skip('git, cmake and a C++ compiler are needed to reach the clone step')
    const enginesRoot = join(dir, 'engines')
    const repoUrl = 'https://127.0.0.1:9/owner/fork.git' // nothing listens on port 9, so the clone fails at once
    const root = join(enginesRoot, 'build', buildDirName(repoUrl, 'main'))
    const bin = join(root, 'build', 'bin', serverExe)
    mkdirSync(join(root, 'build', 'bin'), { recursive: true })
    writeFileSync(bin, 'previous working build')
    const ac = new AbortController()
    if (how === 'is cancelled') ac.abort()
    await assert.rejects(
      runBuild({ repoUrl, branch: 'main', enginesRoot, toolchainDirs: [fakeBin] }, { phase: () => {}, log: () => {} }, ac.signal),
      (e: Error) => how === 'fails' || e.name === 'AbortError',
    )
    assert.equal(readFileSync(bin, 'utf8'), 'previous working build')
    assert.deepEqual(readdirSync(join(enginesRoot, 'build')), [basename(root)])
  })
}

// A parked previous build that was never deleted (the daemon died mid-build) or a failed tree that could not be deleted
// was left beside the build directory for good, often several GB. The next build of that directory sweeps them — and
// only its own: another build's directory name can start with this one's.
test('runBuild: a rebuild sweeps what earlier runs left parked beside its directory, and only that', async (t) => {
  if (process.platform === 'win32') return t.skip('the Windows build needs the MSVC environment')
  const dir = tmpDir('tllm-rebuild-sweep-')
  const fakeBin = join(dir, 'fakebin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'nvcc'), '#!/bin/sh\necho "Cuda compilation tools, release 12.6, V12.6.20"\n', { mode: 0o755 })
  const prereqs = await checkBuildPrereqs([fakeBin])
  if (!prereqs.supported || prereqs.tools.some((x) => ['git', 'cmake', 'gcc'].includes(x.id) && !x.found))
    return t.skip('git, cmake and a C++ compiler are needed to reach the clone step')
  const enginesRoot = join(dir, 'engines')
  const repoUrl = 'https://127.0.0.1:9/owner/fork.git' // nothing listens on port 9, so the clone fails at once
  const name = buildDirName(repoUrl, 'main')
  const buildDir = join(enginesRoot, 'build')
  mkdirSync(join(buildDir, name, 'build', 'bin'), { recursive: true })
  for (const left of [`.${name}-1700000000000.prev`, `.${name}-1700000000001.failed`, `.${name}-dev-1700000000002.prev`]) {
    mkdirSync(join(buildDir, left, 'build'), { recursive: true })
  }
  // The build directory works, and the parked build has a binary too (its delete after a successful build failed):
  // only a build directory WITHOUT a binary gets a parked build put back, so this one is swept, not swapped in.
  writeFileSync(join(buildDir, name, 'build', 'bin', serverExe), 'current build')
  mkdirSync(join(buildDir, `.${name}-1700000000000.prev`, 'build', 'bin'), { recursive: true })
  writeFileSync(join(buildDir, `.${name}-1700000000000.prev`, 'build', 'bin', serverExe), 'stale build')
  await assert.rejects(runBuild({ repoUrl, branch: 'main', enginesRoot, toolchainDirs: [fakeBin] }, { phase: () => {}, log: () => {} }, new AbortController().signal))
  assert.deepEqual(readdirSync(buildDir).sort(), [`.${name}-dev-1700000000002.prev`, name].sort())
  assert.equal(readFileSync(join(buildDir, name, 'build', 'bin', serverExe), 'utf8'), 'current build')
})

// The daemon died mid-build (or a failed build could not move the parked build back): a partial tree sits in the build
// directory and the parked build is the only working copy. The sweep used to delete it, so when that next build failed
// too nothing working was left. It goes back first now — the newest parked build that has a binary — and the rest is
// swept as before.
test('runBuild: a parked build that is the only working copy is put back, not swept', async (t) => {
  if (process.platform === 'win32') return t.skip('the Windows build needs the MSVC environment')
  const dir = tmpDir('tllm-rebuild-lastgood-')
  const fakeBin = join(dir, 'fakebin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'nvcc'), '#!/bin/sh\necho "Cuda compilation tools, release 12.6, V12.6.20"\n', { mode: 0o755 })
  const prereqs = await checkBuildPrereqs([fakeBin])
  if (!prereqs.supported || prereqs.tools.some((x) => ['git', 'cmake', 'gcc'].includes(x.id) && !x.found))
    return t.skip('git, cmake and a C++ compiler are needed to reach the clone step')
  const enginesRoot = join(dir, 'engines')
  const repoUrl = 'https://127.0.0.1:9/owner/fork.git' // nothing listens on port 9, so the clone fails at once
  const name = buildDirName(repoUrl, 'main')
  const buildDir = join(enginesRoot, 'build')
  mkdirSync(join(buildDir, name, 'src'), { recursive: true })
  for (const [ms, content] of [['1700000000000', 'older build'], ['1700000000001', 'last working build']]) {
    mkdirSync(join(buildDir, `.${name}-${ms}.prev`, 'build', 'bin'), { recursive: true })
    writeFileSync(join(buildDir, `.${name}-${ms}.prev`, 'build', 'bin', serverExe), content)
  }
  mkdirSync(join(buildDir, `.${name}-1700000000002.prev`, 'build'), { recursive: true }) // a parked partial tree, no binary
  const logs: string[] = []
  await assert.rejects(runBuild({ repoUrl, branch: 'main', enginesRoot, toolchainDirs: [fakeBin] }, { phase: () => {}, log: (l) => logs.push(l) }, new AbortController().signal))
  assert.equal(readFileSync(join(buildDir, name, 'build', 'bin', serverExe), 'utf8'), 'last working build')
  assert.deepEqual(readdirSync(buildDir), [name])
  assert.ok(logs.some((l) => l.startsWith('Put back the previous build') && l.includes(`.${name}-1700000000001.prev`)), logs.join('\n'))
})

// When only the delete of the failed tree fails (still locked after the retries, but the rename goes through), it is
// moved aside so the previous build still goes back; the next build of that directory sweeps the moved-aside tree.
test('runBuild: a failed tree that cannot be deleted is moved aside and the previous build still goes back', async (t) => {
  if (process.platform === 'win32') return t.skip('the Windows build needs the MSVC environment')
  const dir = tmpDir('tllm-rebuild-locked-')
  const fakeBin = join(dir, 'fakebin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'nvcc'), '#!/bin/sh\necho "Cuda compilation tools, release 12.6, V12.6.20"\n', { mode: 0o755 })
  const prereqs = await checkBuildPrereqs([fakeBin])
  if (!prereqs.supported || prereqs.tools.some((x) => ['git', 'cmake', 'gcc'].includes(x.id) && !x.found))
    return t.skip('git, cmake and a C++ compiler are needed to reach the clone step')
  const enginesRoot = join(dir, 'engines')
  const repoUrl = 'https://127.0.0.1:9/owner/fork.git' // nothing listens on port 9, so the clone fails at once
  const root = join(enginesRoot, 'build', buildDirName(repoUrl, 'main'))
  const bin = join(root, 'build', 'bin', serverExe)
  mkdirSync(join(root, 'build', 'bin'), { recursive: true })
  writeFileSync(bin, 'previous working build')
  const build = () => runBuild({ repoUrl, branch: 'main', enginesRoot, toolchainDirs: [fakeBin] }, { phase: () => {}, log: () => {} }, new AbortController().signal)
  const realRm = fsp.rm
  // build-runner imports rm by name: syncBuiltinESMExports carries the patched function to that binding.
  const locked = t.mock.method(fsp, 'rm', async (p: Parameters<typeof fsp.rm>[0], o?: Parameters<typeof fsp.rm>[1]) => {
    if (String(p) === root) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return realRm(p, o)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(build())
  } finally {
    locked.mock.restore()
    syncBuiltinESMExports()
  }
  assert.ok(locked.mock.calls.some((c) => String(c.arguments[0]) === root), 'the failed tree was deleted through the patched rm')
  assert.equal(readFileSync(bin, 'utf8'), 'previous working build')
  const aside = readdirSync(join(enginesRoot, 'build')).filter((n) => n !== basename(root))
  assert.equal(aside.length, 1)
  const prefix = `.${basename(root)}-`
  assert.ok(aside[0].startsWith(prefix) && /^\d+\.failed$/.test(aside[0].slice(prefix.length)), aside[0])

  // The next build sweeps it.
  await assert.rejects(build())
  assert.equal(readFileSync(bin, 'utf8'), 'previous working build')
  assert.deepEqual(readdirSync(join(enginesRoot, 'build')), [basename(root)])
})

// Each leftover is a whole build tree, often several GB. The sweep deleted them with a recursive rmSync, which held the
// daemon's only thread until the delete ended (seconds with Windows Defender scanning): every request, status poll and
// token stream stalled meanwhile. build-runner imports rm by name: syncBuiltinESMExports carries the spy to that binding.
test('runBuild: the sweep deletes what earlier runs left parked off the event loop', async (t) => {
  if (process.platform === 'win32') return t.skip('the Windows build needs the MSVC environment')
  const dir = tmpDir('tllm-rebuild-sweep-async-')
  const fakeBin = join(dir, 'fakebin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'nvcc'), '#!/bin/sh\necho "Cuda compilation tools, release 12.6, V12.6.20"\n', { mode: 0o755 })
  const prereqs = await checkBuildPrereqs([fakeBin])
  if (!prereqs.supported || prereqs.tools.some((x) => ['git', 'cmake', 'gcc'].includes(x.id) && !x.found))
    return t.skip('git, cmake and a C++ compiler are needed to reach the clone step')
  const enginesRoot = join(dir, 'engines')
  const repoUrl = 'https://127.0.0.1:9/owner/fork.git' // nothing listens on port 9, so the clone fails at once
  const name = buildDirName(repoUrl, 'main')
  const buildDir = join(enginesRoot, 'build')
  mkdirSync(join(buildDir, name, 'build', 'bin'), { recursive: true })
  writeFileSync(join(buildDir, name, 'build', 'bin', serverExe), 'current build')
  const leftovers = [`.${name}-1700000000000.prev`, `.${name}-1700000000001.failed`]
  for (const left of leftovers) mkdirSync(join(buildDir, left, 'build', 'bin'), { recursive: true })
  const deletedAsync = t.mock.method(fsp, 'rm')
  const deletedSync = t.mock.method(fs, 'rmSync')
  syncBuiltinESMExports()
  try {
    await assert.rejects(runBuild({ repoUrl, branch: 'main', enginesRoot, toolchainDirs: [fakeBin] }, { phase: () => {}, log: () => {} }, new AbortController().signal))
  } finally {
    deletedAsync.mock.restore()
    deletedSync.mock.restore()
    syncBuiltinESMExports()
  }
  for (const left of leftovers) {
    const path = join(buildDir, left)
    assert.ok(deletedAsync.mock.calls.some((c) => String(c.arguments[0]) === path), `${left} is deleted with fs/promises rm`)
    assert.ok(!deletedSync.mock.calls.some((c) => String(c.arguments[0]) === path), `${left} is not deleted with rmSync`)
  }
  assert.deepEqual(readdirSync(buildDir), [name])
})

// The route deletes the build a successful rebuild replaced in the background (discardParkedBuild). A rebuild started
// before that delete ends must not sweep the same tree alongside it, or put it back half-deleted as the last working
// copy: it waits for the delete first.
test('runBuild: a rebuild waits for the delete of a build an earlier rebuild replaced before it sweeps', async (t) => {
  if (process.platform === 'win32') return t.skip('the Windows build needs the MSVC environment')
  const dir = tmpDir('tllm-rebuild-discard-')
  const fakeBin = join(dir, 'fakebin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'nvcc'), '#!/bin/sh\necho "Cuda compilation tools, release 12.6, V12.6.20"\n', { mode: 0o755 })
  const prereqs = await checkBuildPrereqs([fakeBin])
  if (!prereqs.supported || prereqs.tools.some((x) => ['git', 'cmake', 'gcc'].includes(x.id) && !x.found))
    return t.skip('git, cmake and a C++ compiler are needed to reach the clone step')
  const enginesRoot = join(dir, 'engines')
  const repoUrl = 'https://127.0.0.1:9/owner/fork.git' // nothing listens on port 9, so the clone fails at once
  const name = buildDirName(repoUrl, 'main')
  const buildDir = join(enginesRoot, 'build')
  mkdirSync(join(buildDir, name, 'build', 'bin'), { recursive: true })
  writeFileSync(join(buildDir, name, 'build', 'bin', serverExe), 'current build')
  const replaced = join(buildDir, `.${name}-1700000000000.prev`)
  mkdirSync(join(replaced, 'build', 'bin'), { recursive: true })
  writeFileSync(join(replaced, 'build', 'bin', serverExe), 'replaced build')
  // Hold the background delete (the first rm of the replaced tree) until the test lets it go.
  let letGo = () => {}
  const held = new Promise<void>((resolve) => { letGo = resolve })
  const realRm = fsp.rm
  let holding = true
  const rmCalls = t.mock.method(fsp, 'rm', async (p: Parameters<typeof fsp.rm>[0], o?: Parameters<typeof fsp.rm>[1]) => {
    if (holding && String(p) === replaced) {
      holding = false
      await held
    }
    return realRm(p, o)
  })
  syncBuiltinESMExports()
  const phases: string[] = []
  let waiting = false
  let sawWait = () => {}
  const waited = new Promise<void>((resolve) => { sawWait = resolve })
  try {
    const discarded = discardParkedBuild(replaced)
    const build = runBuild({ repoUrl, branch: 'main', enginesRoot, toolchainDirs: [fakeBin] }, {
      phase: (p) => phases.push(p),
      log: (l) => {
        if (l.startsWith('Waiting for the delete of a replaced build')) {
          waiting = true
          sawWait()
        }
      },
    }, new AbortController().signal)
    const ended = build.then(() => {}, () => {})
    await Promise.race([waited, ended])
    assert.ok(waiting, 'the build waits for the delete')
    assert.ok(!phases.includes('cloning'), 'nothing past the sweep has run yet')
    assert.equal(rmCalls.mock.calls.filter((c) => String(c.arguments[0]) === replaced).length, 1, 'the sweep has not touched the tree')
    letGo()
    await discarded
    await assert.rejects(build)
  } finally {
    letGo()
    rmCalls.mock.restore()
    syncBuiltinESMExports()
  }
  assert.ok(phases.includes('cloning'), 'the build went on once the delete ended')
  assert.deepEqual(readdirSync(buildDir), [name])
  assert.equal(readFileSync(join(buildDir, name, 'build', 'bin', serverExe), 'utf8'), 'current build')
})

// The daemon's exit kills a running rebuild's compile, but runBuild's restorePreviousBuild never runs: the partial tree
// stays in the build directory and the previous build stays parked, so the registered engine pointed at a missing
// binary until the next build of that same directory. Boot puts it back now, and deletes nothing.
test('restoreInterruptedBuilds: a rebuild the daemon exit cut short gets its previous build back at boot', () => {
  const buildDir = join(tmpDir('tllm-boot-restore-'), 'engines', 'build')
  const name = 'owner-fork-main'
  mkdirSync(join(buildDir, name, 'src'), { recursive: true }) // the partial tree: cloned, never compiled
  for (const [ms, content] of [['1700000000000', 'older build'], ['1700000000001', 'last working build']]) {
    mkdirSync(join(buildDir, `.${name}-${ms}.prev`, 'build', 'bin'), { recursive: true })
    writeFileSync(join(buildDir, `.${name}-${ms}.prev`, 'build', 'bin', serverExe), content)
  }
  const bin = join(buildDir, name, 'build', 'bin', serverExe)
  const logs: string[] = []
  restoreInterruptedBuilds(join(buildDir, '..'), [bin], (l) => logs.push(l))
  assert.equal(readFileSync(bin, 'utf8'), 'last working build')
  assert.ok(logs.some((l) => l.startsWith('Put back the previous build')), logs.join('\n'))
  const left = readdirSync(buildDir).filter((n) => n !== name)
  assert.equal(left.length, 2, 'the older parked build and the partial tree are left for the next build to sweep')
  assert.ok(left.includes(`.${name}-1700000000000.prev`), left.join(', '))
  assert.ok(left.some((n) => /^\.owner-fork-main-\d+\.failed$/.test(n)), left.join(', '))
})

test('restoreInterruptedBuilds: a working build, or a directory no engine claims, is left as it is', () => {
  const buildDir = join(tmpDir('tllm-boot-restore-'), 'engines', 'build')
  mkdirSync(join(buildDir, 'working', 'build', 'bin'), { recursive: true })
  writeFileSync(join(buildDir, 'working', 'build', 'bin', serverExe), 'current build')
  mkdirSync(join(buildDir, 'unclaimed', 'src'), { recursive: true })
  for (const name of ['working', 'unclaimed']) {
    mkdirSync(join(buildDir, `.${name}-1700000000000.prev`, 'build', 'bin'), { recursive: true })
    writeFileSync(join(buildDir, `.${name}-1700000000000.prev`, 'build', 'bin', serverExe), 'parked build')
  }
  const before = readdirSync(buildDir).sort()
  restoreInterruptedBuilds(join(buildDir, '..'), [join(buildDir, 'working', 'build', 'bin', serverExe)], () => {})
  assert.deepEqual(readdirSync(buildDir).sort(), before)
  assert.equal(readFileSync(join(buildDir, 'working', 'build', 'bin', serverExe), 'utf8'), 'current build')
  assert.equal(existsSync(join(buildDir, 'unclaimed', 'build')), false)
  // A missing build directory is a no-op, not a throw.
  restoreInterruptedBuilds(join(buildDir, 'nope'), [], () => {})
})

// Any llama-server counted as a finished build: one the link had half written when the daemon died (or that a compile
// outliving the daemon wrote later) kept the parked previous build from going back. A tree the runner has not marked
// finished is not the working build, in the build directory or parked beside it (a tree like that parked by the next
// build); a tree with no marker at all, as every build made before the marker has, still is (the test above).
test('restoreInterruptedBuilds: a tree still marked unfinished is not the working build, whatever llama-server it holds', () => {
  const buildDir = join(tmpDir('tllm-boot-restore-'), 'engines', 'build')
  const name = 'owner-fork-main'
  const tree = (dir: string, content: string, unfinished: boolean) => {
    mkdirSync(join(buildDir, dir, 'build', 'bin'), { recursive: true })
    writeFileSync(join(buildDir, dir, 'build', 'bin', serverExe), content)
    if (unfinished) writeFileSync(join(buildDir, dir, BUILD_INCOMPLETE_MARKER), '')
  }
  tree(name, 'half-written', true)
  tree(`.${name}-1700000000001.prev`, 'an unfinished tree the next build parked', true)
  tree(`.${name}-1700000000000.prev`, 'last working build', false)
  const bin = join(buildDir, name, 'build', 'bin', serverExe)
  restoreInterruptedBuilds(join(buildDir, '..'), [bin], () => {})
  assert.equal(readFileSync(bin, 'utf8'), 'last working build')
  assert.equal(existsSync(join(buildDir, name, BUILD_INCOMPLETE_MARKER)), false)
})

// A rebuild of a catalog repo (no custom source recorded) cut off by a daemon exit while its new binary was probed: the
// route had already unregistered the engine, so nothing claimed the directory, and the parked working build stayed
// hidden. A tree still marked unfinished is never a working build, so its parked build goes back claimed or not; an
// unclaimed directory with no marker is still left as it is (the test above).
test('restoreInterruptedBuilds: a directory nothing claims that is still marked unfinished gets its previous build back', () => {
  const buildDir = join(tmpDir('tllm-boot-restore-'), 'engines', 'build')
  const name = 'ikawrakow-ik_llama.cpp-main'
  mkdirSync(join(buildDir, name, 'build', 'bin'), { recursive: true })
  writeFileSync(join(buildDir, name, 'build', 'bin', serverExe), 'unprobed build')
  writeFileSync(join(buildDir, name, BUILD_INCOMPLETE_MARKER), '')
  mkdirSync(join(buildDir, `.${name}-1700000000000.prev`, 'build', 'bin'), { recursive: true })
  writeFileSync(join(buildDir, `.${name}-1700000000000.prev`, 'build', 'bin', serverExe), 'last working build')
  const logs: string[] = []
  restoreInterruptedBuilds(join(buildDir, '..'), [], (l) => logs.push(l))
  assert.equal(readFileSync(join(buildDir, name, 'build', 'bin', serverExe), 'utf8'), 'last working build')
  assert.equal(existsSync(join(buildDir, name, BUILD_INCOMPLETE_MARKER)), false)
  assert.ok(logs.some((l) => l.startsWith('Put back the previous build')))
})

// ── Windows Cancel kills the compiler tree, not just cmd.exe ─────────────────────────────────────
// spawn's `signal` only TerminateProcess-es the direct child, which for the configure/compile steps
// is cmd.exe; cmake/ninja/cl/nvcc kept compiling. Faked here on POSIX with a `taskkill` stand-in.
test('runStep on Windows: aborting runs taskkill /PID <pid> /T /F and rejects with AbortError', async (t) => {
  if (process.platform === 'win32') return t.skip('fakes Windows on a POSIX host')
  const dir = tmpDir('tllm-treekill-')
  const argsFile = join(dir, 'taskkill-args')
  writeFileSync(join(dir, 'taskkill'), `#!/bin/sh\necho "$@" > '${argsFile}'\nkill -9 "$2"\n`, { mode: 0o755 })
  const before = process.listeners('exit')
  const actualPlatform = process.platform
  const actualPath = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${actualPath ?? ''}`
  const ac = new AbortController()
  let step: Promise<string>
  let pid = ''
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    step = runStep('sh', ['-c', 'echo $$; exec sleep 30'], { env: { ...process.env }, signal: ac.signal, onLine: (l) => { pid ||= l.trim() } })
  } finally {
    Object.defineProperty(process, 'platform', { value: actualPlatform })
  }
  try {
    while (!pid) await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    await assert.rejects(step, { name: 'AbortError' })
    assert.equal(readFileSync(argsFile, 'utf8').trim(), `/PID ${pid} /T /F`)
    // The step's exit listener goes when its child closes, which can be after the AbortError (taskkill answers
    // first): waited for, so the exit listener counts of the tests below never see it.
    const added = () => process.listeners('exit').filter((l) => !before.includes(l))
    for (let i = 0; i < 500 && added().length > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(added(), [], 'the exit listener is removed with the step')
  } finally {
    process.env.PATH = actualPath
  }
})

// The daemon's exit (Settings Restart, Ctrl+C) ends only the step's direct child on Windows: the job object Node puts
// its children in lets theirs break away, so cmake → ninja → cl/nvcc kept compiling and later dropped an untested
// llama-server.exe where the engine runs from. An exit handler cannot wait, so the tree kill must be synchronous: the
// stand-in's record is there as soon as the listener returns. The stand-in sleeps before it writes it: spawn starts it
// at once, so an async kill's stand-in could otherwise write before the check. The listener is called directly, not
// via a real exit.
test('runStep on Windows: the daemon exit runs taskkill /PID <pid> /T /F synchronously, and leaves no exit listener', async (t) => {
  if (process.platform === 'win32') return t.skip('fakes Windows on a POSIX host')
  const dir = tmpDir('tllm-exitkill-')
  const argsFile = join(dir, 'taskkill-args')
  writeFileSync(join(dir, 'taskkill'), `#!/bin/sh\nsleep 0.3\necho "$@" > '${argsFile}'\nkill -9 "$2"\n`, { mode: 0o755 })
  const before = process.listeners('exit')
  const actualPlatform = process.platform
  const actualPath = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${actualPath ?? ''}`
  let step: Promise<string>
  let pid = ''
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    step = runStep('sh', ['-c', 'echo $$; exec sleep 30'], { env: { ...process.env }, signal: new AbortController().signal, onLine: (l) => { pid ||= l.trim() } })
  } finally {
    Object.defineProperty(process, 'platform', { value: actualPlatform })
  }
  try {
    while (!pid) await new Promise((r) => setTimeout(r, 10))
    const added = process.listeners('exit').filter((l) => !before.includes(l))
    assert.equal(added.length, 1, 'the step ends with the daemon')
    ;(added[0] as () => void)()
    assert.equal(readFileSync(argsFile, 'utf8').trim(), `/PID ${pid} /T /F`)
    await assert.rejects(step, /exited with code null/)
    // By identity, not by count: a listener other code adds or removes meanwhile does not count.
    assert.ok(!process.listeners('exit').includes(added[0]!), 'the exit listener is removed with the step')
  } finally {
    process.env.PATH = actualPath
    try { if (pid) process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ }
    await step.catch(() => {})
  }
})

// Once Node has seen a step exit while something it left still holds its pipes (so 'close', and the step, wait), libuv
// has closed the process handle that kept the pid from being reused: Cancel's and the daemon exit's `taskkill /PID <pid>
// /T /F` could end another process tree that got the number. Runs on every OS: the platform and taskkill are faked.
test('runStep on Windows: once the step has exited, Cancel and the daemon exit send no taskkill for its pid', async (t) => {
  const dir = tmpDir('tllm-exited-step-')
  const holderFile = join(dir, 'holder.pid')
  const taskkills: unknown[] = []
  const realExecFile = childProcess.execFile as (...a: unknown[]) => unknown
  const realSpawnSync = childProcess.spawnSync as (...a: unknown[]) => unknown
  t.mock.method(childProcess, 'execFile', (file: string, ...rest: unknown[]) => {
    if (file !== 'taskkill') return realExecFile(file, ...rest)
    taskkills.push(rest[0])
    const done = rest.find((r) => typeof r === 'function') as ((e: Error | null) => void) | undefined
    process.nextTick(() => done?.(null))
    return {}
  })
  t.mock.method(childProcess, 'spawnSync', (file: string, ...rest: unknown[]) => {
    if (file !== 'taskkill') return realSpawnSync(file, ...rest)
    taskkills.push(rest[0])
    return { status: 0 }
  })
  syncBuiltinESMExports() // build-runner imports both by name
  const before = process.listeners('exit')
  const actualPlatform = process.platform
  const ac = new AbortController()
  let pid = 0
  // The step leaves a detached process holding its stdout and stderr, prints its pid, and exits.
  const script = `const h = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
require('fs').writeFileSync(${JSON.stringify(holderFile)}, String(h.pid))
h.unref()
console.log(process.pid)`
  let step: Promise<string>
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    step = runStep(process.execPath, ['-e', script], { env: { ...process.env }, signal: ac.signal, onLine: (l) => { pid ||= Number(l.trim()) } })
  } finally {
    Object.defineProperty(process, 'platform', { value: actualPlatform })
  }
  const gone = (p: number) => { try { process.kill(p, 0); return false } catch { return true } }
  let holder = 0
  try {
    for (let i = 0; i < 500 && !(pid && existsSync(holderFile)); i++) await new Promise((r) => setTimeout(r, 10))
    holder = Number(readFileSync(holderFile, 'utf8'))
    for (let i = 0; i < 500 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(gone(pid), 'the step has exited')
    await new Promise((r) => setTimeout(r, 200)) // and Node has seen it exit
    const added = process.listeners('exit').filter((l) => !before.includes(l))
    assert.equal(added.length, 1, 'no close yet: what the step left holds its pipes')
    ;(added[0] as () => void)() // the daemon's exit
    ac.abort() // Cancel
    await assert.rejects(step, { name: 'AbortError' })
    assert.deepEqual(taskkills, [], 'no taskkill names the pid of a step Node has seen exit')
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    try { if (holder) process.kill(holder, 'SIGKILL') } catch { /* already gone */ }
    await step.catch(() => {})
  }
  // The exit listener still goes with the step, at its close.
  for (let i = 0; i < 500 && process.listeners('exit').some((l) => !before.includes(l)); i++) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(process.listeners('exit').filter((l) => !before.includes(l)), [])
})

// ── Linux/macOS Cancel kills the whole step, not just cmake ─────────────────────────────────────
// spawn's `signal` SIGTERMs only the direct child (cmake); ninja and the compiler jobs under it kept compiling into
// the tree that the cancelled build is about to remove. The background subshell stands in for them.
test('runStep on Linux/macOS: aborting kills the processes under the step too, and leaves no exit listener', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups')
  const dir = tmpDir('tllm-groupkill-')
  const compiled = join(dir, 'still-compiling')
  const exitListeners = process.listenerCount('exit')
  const ac = new AbortController()
  let started = false
  const step = runStep('sh', ['-c', `(sleep 1; touch '${compiled}') & echo started; wait`], {
    env: { ...process.env }, signal: ac.signal, onLine: () => { started = true },
  })
  while (!started) await new Promise((r) => setTimeout(r, 10))
  ac.abort()
  await assert.rejects(step, { name: 'AbortError' })
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(existsSync(compiled), false, 'the job under the step was killed with it')
  assert.equal(process.listenerCount('exit'), exitListeners)
})

// The group SIGKILL is for the build steps only. runPrereqInstall runs the host package manager (as root, or under
// sudo -n): dnf/zypper (librpm) and brew stop their transaction at a safe point on SIGTERM, a SIGKILL mid-install can
// leave a half-installed package. Cancel keeps asking it to stop, and the daemon's exit does not kill it either.
test('runPrereqInstall: Cancel sends the package manager SIGTERM, not a group SIGKILL, and adds no exit listener', async (t) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return t.skip('prerequisites install on Linux/macOS only')
  const dir = tmpDir('tllm-prereq-cancel-')
  const fakeBin = join(dir, 'fakebin')
  mkdirSync(fakeBin)
  const cleanedUp = join(dir, 'cleaned-up')
  const pm = [
    '#!/bin/sh',
    'PATH=/usr/bin:/bin',
    'case "$1" in --version|update) exit 0 ;; esac',
    `trap 'kill $! 2>/dev/null; touch "${cleanedUp}"; exit 1' TERM`,
    'sleep 30 & echo installing; wait',
    '',
  ].join('\n')
  for (const name of ['apt-get', 'brew']) writeFileSync(join(fakeBin, name), pm, { mode: 0o755 })
  writeFileSync(join(fakeBin, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o755 })
  const exitListeners = process.listenerCount('exit')
  const ac = new AbortController()
  let installing = false
  const actualPath = process.env.PATH
  process.env.PATH = fakeBin // no real cmake is found, so its install command runs (on the fake package manager)
  let install: Promise<void>
  try {
    install = runPrereqInstall(
      { tool: 'cmake', toolchainDirs: [] },
      { phase: () => {}, log: (l) => { if (l === 'installing') installing = true } },
      ac.signal,
    )
    for (let i = 0; !installing && i < 500; i++) await new Promise((r) => setTimeout(r, 10))
  } finally {
    process.env.PATH = actualPath
  }
  assert.ok(installing, 'the fake package manager was reached')
  assert.equal(process.listenerCount('exit'), exitListeners, 'the daemon exit does not SIGKILL the install')
  ac.abort()
  await assert.rejects(install, { name: 'AbortError' })
  for (let i = 0; !existsSync(cleanedUp) && i < 300; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(existsSync(cleanedUp), 'the package manager got SIGTERM and could stop cleanly')
})

// ── Linux CUDA bundling keeps the toolkit's symlinks as symlinks ────────────────────────────────
test('copyCudaRuntimeLibs: .so symlinks become relative links to the bundled library, not extra full copies', (t) => {
  if (process.platform === 'win32') return t.skip('the Linux toolkit layout relies on symlinks')
  const dir = tmpDir('tllm-cudalibs-')
  const cuda = join(dir, 'cuda')
  mkdirSync(join(cuda, 'bin'), { recursive: true })
  mkdirSync(join(cuda, 'lib64'))
  writeFileSync(join(cuda, 'bin', 'nvcc'), '')
  writeFileSync(join(cuda, 'lib64', 'libcublas.so.12.4.5.8'), 'x'.repeat(1000))
  symlinkSync('libcublas.so.12.4.5.8', join(cuda, 'lib64', 'libcublas.so.12'))
  symlinkSync('libcublas.so.12', join(cuda, 'lib64', 'libcublas.so'))
  // A link that leaves the directory can't be kept as a link: it is still copied as a file.
  mkdirSync(join(dir, 'elsewhere'))
  writeFileSync(join(dir, 'elsewhere', 'real-cudart'), 'cudart')
  symlinkSync(join(dir, 'elsewhere', 'real-cudart'), join(cuda, 'lib64', 'libcudart.so.12'))
  const dest = join(dir, 'out')
  mkdirSync(dest)
  assert.equal(copyCudaRuntimeLibs({ PATH: join(cuda, 'bin') }, dest, () => {}), 4)
  assert.ok(lstatSync(join(dest, 'libcublas.so.12.4.5.8')).isFile())
  assert.equal(readlinkSync(join(dest, 'libcublas.so.12')), 'libcublas.so.12.4.5.8')
  assert.equal(readlinkSync(join(dest, 'libcublas.so')), 'libcublas.so.12')
  assert.equal(readFileSync(join(dest, 'libcublas.so'), 'utf8').length, 1000)
  assert.ok(lstatSync(join(dest, 'libcudart.so.12')).isFile())
  assert.equal(readFileSync(join(dest, 'libcudart.so.12'), 'utf8'), 'cudart')
})

import { findReleaseEngineForCatalogEntry, pickReleaseSource } from './build-runner'

const PRISM_RELEASE_ENTRY = {
  repo: 'PrismML-Eng/llama.cpp',
  homepage: 'https://github.com/PrismML-Eng/llama.cpp',
  releaseInstall: true,
  defaultBranch: 'prism',
}
const releaseEngine = (id: string, repo: string, addedAt?: string) => ({ id, addedAt, release: { repo } })

test('findReleaseEngineForCatalogEntry: claims a release engine of its repo on the default line only', () => {
  const engines = [releaseEngine('r1', 'PrismML-Eng/llama.cpp')]
  for (const branch of [undefined, '', 'prism']) {
    assert.equal(findReleaseEngineForCatalogEntry(engines, PRISM_RELEASE_ENTRY, branch)?.id, 'r1')
  }
  assert.equal(findReleaseEngineForCatalogEntry(engines, PRISM_RELEASE_ENTRY, 'master'), undefined)
})

test('findReleaseEngineForCatalogEntry: excludeFromSourceMatch, no releaseInstall, and pinned entries never claim', () => {
  const engines = [releaseEngine('r1', 'ggml-org/llama.cpp')]
  const llamaCpp = { repo: 'ggml-org/llama.cpp', homepage: 'https://github.com/ggml-org/llama.cpp', releaseInstall: true, excludeFromSourceMatch: true }
  assert.equal(findReleaseEngineForCatalogEntry(engines, llamaCpp), undefined)
  assert.equal(findReleaseEngineForCatalogEntry(engines, { ...llamaCpp, excludeFromSourceMatch: undefined, releaseInstall: undefined }), undefined)
  assert.equal(findReleaseEngineForCatalogEntry(engines, { ...llamaCpp, excludeFromSourceMatch: undefined, sourceCommit: 'abc' }), undefined)
  assert.equal(findReleaseEngineForCatalogEntry(engines, { ...llamaCpp, excludeFromSourceMatch: undefined, patchUrl: 'https://x/p.patch' }), undefined)
})

test('findReleaseEngineForCatalogEntry: a different repo does not match; URL and case forms of the same repo do', () => {
  assert.equal(findReleaseEngineForCatalogEntry([releaseEngine('r1', 'Anbeeld/beellama.cpp')], PRISM_RELEASE_ENTRY), undefined)
  assert.equal(findReleaseEngineForCatalogEntry([releaseEngine('r1', 'https://github.com/PrismML-Eng/llama.cpp')], PRISM_RELEASE_ENTRY)?.id, 'r1')
  assert.equal(findReleaseEngineForCatalogEntry([releaseEngine('r1', 'prismml-eng/llama.cpp')], PRISM_RELEASE_ENTRY)?.id, 'r1')
})

test('findReleaseEngineForCatalogEntry: an engine with sourceRepo but no release is never returned', () => {
  const sourceBuild = { id: 's1', sourceRepo: 'PrismML-Eng/llama.cpp' } as unknown as { id: string; release?: { repo: string } }
  assert.equal(findReleaseEngineForCatalogEntry([sourceBuild], PRISM_RELEASE_ENTRY), undefined)
})

test('findReleaseEngineForCatalogEntry: the active engine wins, then the newest addedAt, whatever the registry order', () => {
  const older = releaseEngine('a', 'PrismML-Eng/llama.cpp', '2026-01-01T00:00:00Z')
  const newer = releaseEngine('b', 'PrismML-Eng/llama.cpp', '2026-02-01T00:00:00Z')
  assert.equal(findReleaseEngineForCatalogEntry([older, newer], PRISM_RELEASE_ENTRY)?.id, 'b')
  assert.equal(findReleaseEngineForCatalogEntry([newer, older], PRISM_RELEASE_ENTRY)?.id, 'b')
  assert.equal(findReleaseEngineForCatalogEntry([older, newer], PRISM_RELEASE_ENTRY, undefined, 'a')?.id, 'a')
  assert.equal(findReleaseEngineForCatalogEntry([newer, older], PRISM_RELEASE_ENTRY, undefined, 'a')?.id, 'a')
})

test('findReleaseEngineForCatalogEntry: an addedAt tie goes to the smallest id', () => {
  const x = releaseEngine('x', 'PrismML-Eng/llama.cpp', '2026-01-01T00:00:00Z')
  const y = releaseEngine('y', 'PrismML-Eng/llama.cpp', '2026-01-01T00:00:00Z')
  assert.equal(findReleaseEngineForCatalogEntry([y, x], PRISM_RELEASE_ENTRY)?.id, 'x')
  assert.equal(findReleaseEngineForCatalogEntry([x, y], PRISM_RELEASE_ENTRY)?.id, 'x')
})

test('pickReleaseSource: newest addedAt wins, a tie goes to the smaller binPath, either input order', () => {
  const a = { binPath: join('b', 'x'), addedAt: '2026-01-01T00:00:00Z' }
  const b = { binPath: join('a', 'x'), addedAt: '2026-01-01T00:00:00Z' }
  assert.equal(pickReleaseSource([a, b])?.binPath, b.binPath)
  assert.equal(pickReleaseSource([b, a])?.binPath, b.binPath)
  const newest = { binPath: join('z', 'x'), addedAt: '2026-03-01T00:00:00Z' }
  assert.equal(pickReleaseSource([a, b, newest])?.binPath, newest.binPath)
})

test('pickReleaseSource: a missing or unparseable addedAt sorts oldest; an empty list is undefined', () => {
  const dated = { binPath: 'z', addedAt: '2020-01-01T00:00:00Z' }
  assert.equal(pickReleaseSource([{ binPath: 'a' }, dated])?.binPath, 'z')
  assert.equal(pickReleaseSource([{ binPath: 'a', addedAt: 'garbage' }, dated])?.binPath, 'z')
  assert.equal(pickReleaseSource([]), undefined)
})
