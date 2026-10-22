// A Python engine's Install redoes its environment (`--reinstall`) only when an earlier install did not finish, and a
// finished one is left alone (py-env-marker.ts). Before, LiteRT-LM passed --reinstall on every plain Install (a full
// rewrite of a complete environment each time), and the others never did, so an Install over a venv that a cut-short
// install left behind registered a broken engine. A stand-in uv records every call; its `venv` makes a stand-in
// interpreter that answers the version probes.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PY_ENV_MARKER } from './py-env-marker'
import { ensureVllmEnv } from './vllm'
import { ensureSglangEnv } from './sglang'
import { ensureLayaEnv } from './laya'
import { ensureLitertLmEnv } from './litert-lm'
import { ensureMlxEnv } from './mlx'
import { ensureRapidMlxEnv } from './rapid-mlx'
import { ensureMlxVlmEnv } from './mlx-vlm'
import { tmpDir } from '../test-support/tmp'

const POSIX = process.platform === 'win32' ? 'POSIX shell stand-ins for uv and python' : false
const MAC = process.platform !== 'darwin' ? 'the MLX engines provision on macOS only' : false

/** A root whose `uv/uv` is a stand-in (ensureUv then downloads nothing). */
function standInRoot(): { root: string; log: string; failInstall: string; calls: () => string[] } {
  const root = tmpDir('tllm-py-marker-')
  mkdirSync(join(root, 'uv'))
  const log = join(root, 'uv.log')
  const failInstall = join(root, 'fail-install')
  const python = join(root, 'python')
  writeFileSync(python, '#!/bin/sh\ncase "$1" in --version) echo "Python 3.12.1" ;; *) echo 1.0.0 ;; esac\n')
  chmodSync(python, 0o755)
  writeFileSync(join(root, 'uv', 'uv'), [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    'for a; do last=$a; done',
    // `uv venv … <envDir>`: an interpreter, and Rapid-MLX's console script, which answer the probes.
    `if [ "$1" = venv ]; then mkdir -p "$last/bin" && cp '${python}' "$last/bin/python" && cp '${python}' "$last/bin/rapid-mlx"; exit 0; fi`,
    `if [ "$1" = pip ] && [ -f '${failInstall}' ]; then echo 'install cut short' >&2; exit 1; fi`,
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(join(root, 'uv', 'uv'), 0o755)
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  return { root, log, failInstall, calls }
}

type Ensure = (root: string, upgrade: boolean) => Promise<unknown>
const ENGINES: Array<{ name: string; dir: string; upgradeFlag: string; ensure: Ensure; skip: string | false }> = [
  { name: 'vLLM', dir: 'vllm', upgradeFlag: '-U', ensure: (r, u) => ensureVllmEnv(r, undefined, u), skip: POSIX },
  { name: 'SGLang', dir: 'sglang', upgradeFlag: '-U', ensure: (r, u) => ensureSglangEnv(r, undefined, u), skip: POSIX },
  { name: 'Laya', dir: 'laya', upgradeFlag: '--upgrade', ensure: (r, u) => ensureLayaEnv(r, undefined, u), skip: POSIX },
  { name: 'LiteRT-LM', dir: 'litert-lm', upgradeFlag: '-U', ensure: (r, u) => ensureLitertLmEnv(r, undefined, u), skip: POSIX },
  { name: 'MLX', dir: 'mlx', upgradeFlag: '--upgrade', ensure: (r, u) => ensureMlxEnv(r, undefined, u), skip: POSIX || MAC },
  { name: 'Rapid-MLX', dir: 'rapid-mlx', upgradeFlag: '--upgrade', ensure: (r, u) => ensureRapidMlxEnv(r, undefined, u), skip: POSIX || MAC },
  { name: 'MLX-VLM', dir: 'mlx-vlm', upgradeFlag: '--upgrade', ensure: (r, u) => ensureMlxVlmEnv(r, undefined, u), skip: POSIX || MAC },
]

const installCalls = (calls: string[]) => calls.filter((c) => c.startsWith('pip install'))

for (const e of ENGINES) {
  test(`${e.name}: Install redoes only an environment whose last install did not finish, and Update keeps ${e.upgradeFlag}`, { skip: e.skip }, async () => {
    const s = standInRoot()
    const envDir = join(s.root, e.dir, 'venv')
    const marker = join(envDir, PY_ENV_MARKER)

    // No venv yet: a new one, a plain install, and the marker once the probe has answered.
    await e.ensure(s.root, false)
    assert.ok(s.calls().some((c) => c.startsWith('venv ')), 'the venv was created')
    assert.equal(installCalls(s.calls()).length, 1)
    assert.ok(!installCalls(s.calls())[0].includes('--reinstall'), 'a fresh venv needs no --reinstall')
    assert.ok(existsSync(marker), 'a finished install leaves its marker')

    // A venv the last install finished: Install again redoes nothing.
    rmSync(s.log)
    await e.ensure(s.root, false)
    assert.ok(!installCalls(s.calls())[0].includes('--reinstall'), 'a finished environment is not rewritten')
    assert.ok(!s.calls().some((c) => c.startsWith('venv ')), 'nor recreated')
    assert.ok(existsSync(marker))

    // An install cut short (a Cancel, a crash, the daemon dying with it): no marker is left.
    writeFileSync(s.failInstall, '')
    await assert.rejects(e.ensure(s.root, false))
    assert.equal(existsSync(marker), false, 'a cut-short install leaves no marker')
    rmSync(s.failInstall)

    // An Update over it keeps its own flag.
    rmSync(s.log)
    writeFileSync(s.failInstall, '')
    await assert.rejects(e.ensure(s.root, true))
    rmSync(s.failInstall)
    const update = installCalls(s.calls())[0].split(' ')
    assert.ok(update.includes(e.upgradeFlag) && !update.includes('--reinstall'), `Update: ${update.join(' ')}`)

    // The next plain Install over the unfinished venv redoes it, and marks it whole again.
    rmSync(s.log)
    await e.ensure(s.root, false)
    assert.ok(installCalls(s.calls())[0].split(' ').includes('--reinstall'), 'the unfinished environment is redone')
    assert.ok(existsSync(marker))
  })
}
