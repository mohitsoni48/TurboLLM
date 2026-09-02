import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { buildCommands, buildEnv, prereqInstallCommands, withInstallCommands, CMAKE_CONFIGURE_ARGS, CMAKE_CONFIGURE_ARGS_MACOS, type BuildPrereqTool, type PackageManager } from './build-prereqs'
import { noInstallCommandError } from './build-runner'

const PATH_KEY = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'

// NOTE: use delimiter-free dir names throughout — on Linux `path.delimiter` is ':', so a Windows
// drive path like "C:\\x" would split on its own colon and make these assertions platform-fragile.

/** Run `fn` with PATH pinned to `seed`, restoring the machine's real one afterward.
 *
 *  Any assertion about buildEnv's OUTPUT has to control its INPUT. buildEnv deliberately
 *  normalizes PATH (drops empty/blank segments — see the anti-doubled-delimiter test below, which
 *  encodes the real intended behavior), so "the inherited PATH comes through unchanged" is only a
 *  coherent expectation when what was inherited was already clean. The original versions of the
 *  two tests below read the developer's REAL PATH and asserted byte-identity, which made them pass
 *  or fail by machine: this dev box's PATH contains both `;;` and a trailing `;`, so those
 *  assertions and the normalization requirement contradicted each other outright and the file
 *  failed 2/15 here while passing elsewhere (2026-07-29). */
function withPath(seed: string, fn: () => void): void {
  const orig = process.env[PATH_KEY]
  try {
    process.env[PATH_KEY] = seed
    fn()
  } finally {
    if (orig === undefined) delete process.env[PATH_KEY]
    else process.env[PATH_KEY] = orig
  }
}

test('buildEnv: no dirs → a copy of process.env, an already-clean PATH carried through as-is', () => {
  const clean = ['tllm_p1', 'tllm_p2'].join(delimiter)
  withPath(clean, () => {
    const env = buildEnv([])
    assert.equal(env[PATH_KEY], clean)
    assert.notEqual(env, process.env) // a copy, not the live object
  })
})

test('buildEnv: no dirs → a MESSY inherited PATH is normalized, not carried through verbatim', () => {
  // The other half of the pair above, and the case that used to be untested despite being the
  // one every real machine can hit: buildEnv is expected to clean this up, so a test asserting
  // "unchanged" against such a PATH would be asserting the opposite of the intended behavior.
  withPath(`${delimiter}tllm_p1${delimiter}${delimiter} ${delimiter}tllm_p2${delimiter}`, () => {
    assert.equal(buildEnv([])[PATH_KEY], `tllm_p1${delimiter}tllm_p2`)
  })
})

test('buildEnv: prepends dirs to PATH in order, before the inherited PATH', () => {
  const inherited = ['tllm_p1', 'tllm_p2'].join(delimiter)
  withPath(inherited, () => {
    // Exact equality against a fixture, rather than startsWith/endsWith against whatever the
    // machine happens to have — pins the full result including ordering.
    assert.equal(
      buildEnv(['tllm_dir_a', 'tllm_dir_b'])[PATH_KEY],
      ['tllm_dir_a', 'tllm_dir_b', 'tllm_p1', 'tllm_p2'].join(delimiter),
    )
  })
})

test('buildEnv: every segment of the REAL inherited PATH survives, in order, whatever shape it is in', () => {
  // Deliberately reads the live process.env — this is the property the two tests above were
  // reaching for when they compared strings: on a real machine nothing may be dropped or
  // reordered. Byte-identity can't be that property (a PATH with `;;` or a trailing `;` is
  // normalized by design), but "same segments, same order, prefixed by our dirs" can, and it
  // holds on any machine.
  const inherited = (process.env[PATH_KEY] ?? '').split(delimiter).map((s) => s.trim()).filter(Boolean)
  const out = (buildEnv(['tllm_dir'])[PATH_KEY] ?? '').split(delimiter)
  assert.deepEqual(out, ['tllm_dir', ...inherited])
})

test('buildEnv: drops empty/whitespace dirs', () => {
  const env = buildEnv(['', '   ', 'tllm_real_dir'])
  assert.ok((env[PATH_KEY] ?? '').startsWith('tllm_real_dir' + delimiter))
})

test('buildEnv: does not create a duplicate PATH/Path key', () => {
  const env = buildEnv(['tllm_x'])
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
  assert.equal(pathKeys.length, Object.keys(process.env).filter((k) => k.toLowerCase() === 'path').length)
})

// Regression: a trailing/leading/doubled delimiter in PATH can make Windows fail to resolve a
// bare command with `spawn cmd.exe ENOENT`. buildEnv must never emit an empty PATH segment.
test('buildEnv: never produces a leading/trailing/doubled delimiter in PATH', () => {
  const orig = process.env[PATH_KEY]
  try {
    for (const seed of [
      '', // empty existing PATH
      'onlyone',
      `a${delimiter}b`,
      `${delimiter}a${delimiter}b${delimiter}`, // leading + trailing delimiter
      `a${delimiter}${delimiter}b`, // doubled delimiter
      `${delimiter}${delimiter}`, // nothing but delimiters
    ]) {
      process.env[PATH_KEY] = seed
      for (const dirs of [[], ['tllm_dir'], ['', '  ', 'tllm_dir']]) {
        const env = buildEnv(dirs)
        const path = env[PATH_KEY] ?? ''
        assert.ok(!path.startsWith(delimiter), `leading delimiter for seed=${JSON.stringify(seed)} dirs=${JSON.stringify(dirs)}`)
        assert.ok(!path.endsWith(delimiter), `trailing delimiter for seed=${JSON.stringify(seed)} dirs=${JSON.stringify(dirs)}`)
        assert.ok(!path.includes(delimiter + delimiter), `doubled delimiter for seed=${JSON.stringify(seed)} dirs=${JSON.stringify(dirs)}`)
        // No empty segment survived.
        assert.ok(path.split(delimiter).every((s) => s.length > 0) || path === '', `empty segment for seed=${JSON.stringify(seed)}`)
      }
    }
  } finally {
    if (orig === undefined) delete process.env[PATH_KEY]
    else process.env[PATH_KEY] = orig
  }
})

// The Windows `spawn cmd.exe ENOENT` fix relies on the OS-critical vars surviving into the child
// env: without SystemRoot/PATHEXT/ComSpec the OS loader can't resolve cmd.exe regardless of PATH.
// (Env keys are case-insensitive on Windows, so we look them up case-insensitively.)
test('buildEnv: preserves the parent env vars (OS-critical ones survive the copy)', () => {
  const lookup = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
    const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase())
    return k === undefined ? undefined : env[k]
  }
  const key = '__TLLM_TEST_OS_VAR__'
  const saved = process.env[key]
  try {
    process.env[key] = 'sentinel-value'
    const env = buildEnv(['tllm_dir'])
    assert.equal(lookup(env, key), 'sentinel-value')
    // Whatever the parent actually has for the real OS-critical vars must carry through verbatim.
    for (const name of ['ComSpec', 'PATHEXT', 'SystemRoot', 'windir']) {
      assert.equal(lookup(env, name), lookup(process.env, name), `${name} not preserved`)
    }
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

test('buildCommands: includes --branch when a branch is given', () => {
  const cmds = buildCommands('https://github.com/owner/repo', 'main', 'windows')
  assert.equal(cmds[0], 'git clone --branch "main" --depth 1 "https://github.com/owner/repo" turbo-build')
})

test('buildCommands: omits --branch when no branch (or empty/whitespace) is given', () => {
  const expected = 'git clone --depth 1 "https://github.com/owner/repo" turbo-build'
  assert.equal(buildCommands('https://github.com/owner/repo', undefined, 'windows')[0], expected)
  assert.equal(buildCommands('https://github.com/owner/repo', '', 'windows')[0], expected)
  assert.equal(buildCommands('https://github.com/owner/repo', '   ', 'windows')[0], expected)
})

test('buildCommands: passes the repo URL through verbatim', () => {
  const url = 'https://github.com/ikawrakow/ik_llama.cpp.git'
  const cmds = buildCommands(url, 'sidestream', 'windows')
  assert.ok(cmds[0].includes(url))
})

test('buildCommands: produces the Windows + CUDA cmake steps (incl. the unsupported-compiler escape hatch) and the binary-location note', () => {
  const cmds = buildCommands('https://github.com/owner/repo', undefined, 'windows')
  assert.deepEqual(cmds.slice(1, 4), [
    'cd turbo-build',
    `cmake -B build ${CMAKE_CONFIGURE_ARGS.join(' ')}`,
    'cmake --build build --config Release -j --target llama-server',
  ])
  assert.match(cmds[cmds.length - 1], /llama-server\.exe/)
  assert.match(cmds[cmds.length - 1], /Add your own engine/)
})

test('buildCommands: produces the Linux + CUDA cmake steps (no config flag, no .exe) and the binary-location note', () => {
  const cmds = buildCommands('https://github.com/owner/repo', undefined, 'linux')
  assert.deepEqual(cmds.slice(1, 4), [
    'cd turbo-build',
    `cmake -B build ${CMAKE_CONFIGURE_ARGS.join(' ')}`,
    'cmake --build build -j --target llama-server',
  ])
  assert.match(cmds[cmds.length - 1], /build\/bin\/llama-server/)
  assert.ok(!cmds[cmds.length - 1].includes('.exe'))
})

// Regression: the manual path used to skip bundling the CUDA runtime — the build succeeded
// but the produced engine silently ran CPU-only until the DLLs/libs were found by hand.
test('buildCommands: Windows bundles the CUDA runtime DLLs (both CUDA 12 and 13 layouts) next to the binary', () => {
  const cmds = buildCommands('https://github.com/owner/repo', undefined, 'windows')
  const copyStep = cmds[4]
  assert.match(copyStep, /^for %f in \(.*\) do copy \/y "%f" "build\\bin\\Release\\" >nul 2>&1$/)
  assert.match(copyStep, /"%CUDA_PATH%\\bin\\cudart64_\*\.dll"/)
  assert.match(copyStep, /"%CUDA_PATH%\\bin\\x64\\cudart64_\*\.dll"/)
})

test('buildCommands: Linux bundles the CUDA runtime shared libs next to the binary', () => {
  const cmds = buildCommands('https://github.com/owner/repo', undefined, 'linux')
  assert.equal(cmds[4], 'CUDA_ROOT="$(dirname "$(dirname "$(command -v nvcc)")")"')
  const copyStep = cmds[5]
  assert.match(copyStep, /^cp .* build\/bin\/ 2>\/dev\/null$/)
  assert.match(copyStep, /\$CUDA_ROOT\/lib64\/libcudart\.so\*/)
})

test('buildCommands: produces the macOS + Metal cmake steps (no CUDA flags, no runtime-copy step) and the binary-location note', () => {
  const cmds = buildCommands('https://github.com/owner/repo', undefined, 'macos')
  assert.deepEqual(cmds, [
    'git clone --depth 1 "https://github.com/owner/repo" turbo-build',
    'cd turbo-build',
    `cmake -B build ${CMAKE_CONFIGURE_ARGS_MACOS.join(' ')}`,
    'cmake --build build -j --target llama-server',
    '# Built binary: build/bin/llama-server — add it via "Add your own engine".',
  ])
})

test('CMAKE_CONFIGURE_ARGS_MACOS: enables Metal + Release, no CUDA flags', () => {
  assert.deepEqual(CMAKE_CONFIGURE_ARGS_MACOS, ['-DGGML_METAL=ON', '-DCMAKE_BUILD_TYPE=Release'])
})

// ── Package-manager install commands ────────────────────────────────────────
// The headless fix: on a self-hosted box with no local browser, a prereq's `installUrl` opens a
// website in the OPERATOR's browser and installs nothing on the server that needs the toolchain.
// These are the commands the daemon runs on the host instead (build-runner.ts runPrereqInstall).
// Pure command GENERATION only — nothing here ever runs an installer.

const tool = (id: BuildPrereqTool['id'], found = false): BuildPrereqTool =>
  ({ id, name: id, found, installUrl: `https://example.invalid/${id}` })

test('prereqInstallCommands: apt refreshes the package lists before installing', () => {
  // Load-bearing, not belt-and-braces: a fresh Debian/Ubuntu container has NO apt lists, so a
  // bare `apt-get install` there always fails with "Unable to locate package" — and a container
  // is exactly the environment this feature exists for.
  assert.deepEqual(prereqInstallCommands('apt-get', 'cmake', true), [
    ['apt-get', 'update'],
    ['apt-get', 'install', '-y', 'cmake'],
  ])
})

test('prereqInstallCommands: non-root prefixes sudo -n (never interactive), root does not', () => {
  // `sudo -n` on purpose: stdin isn't attached to anything, so a password prompt would hang
  // forever instead of failing with something the user can read.
  assert.deepEqual(prereqInstallCommands('dnf', 'git', false), [['sudo', '-n', 'dnf', 'install', '-y', 'git']])
  assert.deepEqual(prereqInstallCommands('dnf', 'git', true), [['dnf', 'install', '-y', 'git']])
})

test('prereqInstallCommands: every Linux manager installs git and cmake non-interactively', () => {
  for (const pm of ['apt-get', 'dnf', 'pacman', 'zypper'] as PackageManager[]) {
    for (const id of ['git', 'cmake'] as BuildPrereqTool['id'][]) {
      const cmds = prereqInstallCommands(pm, id, true)
      assert.ok(cmds && cmds.length > 0, `${pm}/${id} should have an install command`)
      const install = cmds[cmds.length - 1]
      assert.equal(install[0], pm)
      assert.ok(install.includes(id), `${pm}/${id} should install the "${id}" package`)
      // No manager may be able to stop and ask a question mid-install.
      assert.ok(
        install.some((a) => a === '-y' || a === '--noconfirm' || a === '--non-interactive'),
        `${pm} install is missing its non-interactive flag`,
      )
    }
  }
})

test('prereqInstallCommands: the compiler maps to each distro\'s C++ toolchain package', () => {
  assert.deepEqual(prereqInstallCommands('apt-get', 'gcc', true)![1], ['apt-get', 'install', '-y', 'build-essential'])
  assert.deepEqual(prereqInstallCommands('dnf', 'gcc', true), [['dnf', 'install', '-y', 'gcc-c++', 'make']])
  assert.deepEqual(prereqInstallCommands('pacman', 'gcc', true), [['pacman', '-Sy', '--noconfirm', 'base-devel']])
  assert.deepEqual(prereqInstallCommands('zypper', 'gcc', true), [['zypper', '--non-interactive', 'install', 'gcc-c++', 'make']])
})

test('prereqInstallCommands: pacman refreshes its db (-Sy, not -S)', () => {
  // A container's pacman db is typically empty/stale, which makes a plain -S install fail.
  assert.equal(prereqInstallCommands('pacman', 'git', true)![0][1], '-Sy')
})

test('prereqInstallCommands: brew is never run under sudo, even for a non-root caller', () => {
  // Homebrew refuses to run as root and breaks its own prefix permissions if forced.
  assert.deepEqual(prereqInstallCommands('brew', 'cmake', false), [['brew', 'install', 'cmake']])
  assert.deepEqual(prereqInstallCommands('brew', 'git', true), [['brew', 'install', 'git']])
})

test('prereqInstallCommands: CUDA only where a genuine one-command install exists', () => {
  // apt (nvidia-cuda-toolkit) and pacman (cuda) ship real single-package toolkits. dnf/zypper
  // realistically need NVIDIA's own repo bootstrap, and macOS has no CUDA at all — those keep
  // the website link rather than TurboLLM guessing at a fragile repo setup.
  assert.deepEqual(prereqInstallCommands('apt-get', 'cuda', true)![1], ['apt-get', 'install', '-y', 'nvidia-cuda-toolkit'])
  assert.deepEqual(prereqInstallCommands('pacman', 'cuda', true), [['pacman', '-Sy', '--noconfirm', 'cuda']])
  assert.equal(prereqInstallCommands('dnf', 'cuda', true), undefined)
  assert.equal(prereqInstallCommands('zypper', 'cuda', true), undefined)
  assert.equal(prereqInstallCommands('brew', 'cuda', true), undefined)
})

test('prereqInstallCommands: MSVC never gets one (Windows-only, GUI installer)', () => {
  for (const pm of ['apt-get', 'dnf', 'pacman', 'zypper', 'brew'] as PackageManager[]) {
    assert.equal(prereqInstallCommands(pm, 'msvc', true), undefined)
  }
})

test('prereqInstallCommands: the macOS compiler stays link-only (Xcode CLT needs a GUI prompt)', () => {
  assert.equal(prereqInstallCommands('brew', 'gcc', true), undefined)
})

test('withInstallCommands: only MISSING tools get commands; found ones are untouched', () => {
  const out = withInstallCommands([tool('git', true), tool('cmake', false)], 'apt-get')
  assert.equal(out[0].installCommands, undefined)
  assert.ok((out[1].installCommands?.length ?? 0) > 0)
})

test('withInstallCommands: no package manager → every tool keeps only its website link', () => {
  const tools = [tool('git'), tool('cmake'), tool('cuda')]
  for (const t of withInstallCommands(tools, null)) assert.equal(t.installCommands, undefined)
})

test('withInstallCommands: a tool with no clean install (CUDA on dnf) keeps link-only', () => {
  const out = withInstallCommands([tool('cuda'), tool('git')], 'dnf')
  assert.equal(out[0].installCommands, undefined)
  assert.ok((out[1].installCommands?.length ?? 0) > 0)
})

test('noInstallCommandError: null when there IS something to run', () => {
  assert.equal(noInstallCommandError({ ...tool('git'), installCommands: [['apt-get', 'install', 'git']] }, 'apt-get'), null)
})

test('noInstallCommandError: names the manager, or says none was found, and always keeps the link', () => {
  const withPm = noInstallCommandError(tool('cuda'), 'dnf')
  assert.match(withPm!, /dnf/)
  assert.match(withPm!, /example\.invalid\/cuda/)
  const noPm = noInstallCommandError(tool('cuda'), null)
  assert.match(noPm!, /No supported package manager/)
  assert.match(noPm!, /example\.invalid\/cuda/)
})
