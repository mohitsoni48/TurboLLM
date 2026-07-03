import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { buildCommands, buildEnv } from './build-prereqs'

const PATH_KEY = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'

test('buildEnv: no dirs → a copy of process.env (PATH unchanged)', () => {
  const env = buildEnv([])
  assert.equal(env[PATH_KEY], process.env[PATH_KEY])
  assert.notEqual(env, process.env) // a copy, not the live object
})

// NOTE: use delimiter-free dir names below — on Linux `path.delimiter` is ':', so a Windows
// drive path like "C:\\x" would split on its own colon and make these assertions platform-fragile.
test('buildEnv: prepends dirs to PATH in order, before the inherited PATH', () => {
  const a = 'tllm_dir_a'
  const b = 'tllm_dir_b'
  const env = buildEnv([a, b])
  assert.ok((env[PATH_KEY] ?? '').startsWith(a + delimiter + b + delimiter))
  assert.ok((env[PATH_KEY] ?? '').endsWith(process.env[PATH_KEY] ?? ''))
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

test('buildCommands: produces the Windows + CUDA cmake steps and the binary-location note', () => {
  const cmds = buildCommands('https://github.com/owner/repo', undefined, 'windows')
  assert.deepEqual(cmds.slice(1, 4), [
    'cd turbo-build',
    'cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release',
    'cmake --build build --config Release -j --target llama-server',
  ])
  assert.match(cmds[cmds.length - 1], /llama-server\.exe/)
  assert.match(cmds[cmds.length - 1], /Add your own engine/)
})

test('buildCommands: produces the Linux + CUDA cmake steps (no config flag, no .exe) and the binary-location note', () => {
  const cmds = buildCommands('https://github.com/owner/repo', undefined, 'linux')
  assert.deepEqual(cmds.slice(1, 4), [
    'cd turbo-build',
    'cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release',
    'cmake --build build -j --target llama-server',
  ])
  assert.match(cmds[cmds.length - 1], /build\/bin\/llama-server/)
  assert.ok(!cmds[cmds.length - 1].includes('.exe'))
})
