// A language server (npx and the server it runs) and the tsserver path probe run through util/tether.ts, so they end
// the moment the daemon does. Before, only dispose() or the daemon's teardown killed npx, and only npx itself: a
// daemon that died without one left npx and its server running, parented to init.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { killRecorded, record, srcUrl, startStandInDaemon, waitGone, writtenTo } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'a POSIX shell stand-in for npx' : false

/** A stand-in `npx` on PATH: records its pid and a child's, then hangs without ever answering. */
function fakeNpx(dir: string): { bin: string; pids: string } {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const pids = join(dir, 'npx.pids')
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nsleep 300 &\necho "$$ $!" > ${pids}\nwait\n`)
  chmodSync(join(bin, 'npx'), 0o755)
  return { bin, pids }
}

async function pidsIn(file: string): Promise<number[]> {
  const deadline = Date.now() + 5000
  for (;;) {
    const pids = (await writtenTo(file)).trim().split(' ').map(Number)
    if (pids.length === 2 && pids.every((p) => p > 0)) return pids
    if (Date.now() >= deadline) throw new Error(`${file} holds no two pids`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

for (const [what, language] of [['a language server', 'python'], ['the tsserver path probe', 'typescript']] as const) {
  test(`a daemon SIGKILLed while ${what} runs takes npx and its child with it`, { skip }, async () => {
    const dir = tmpDir('tllm-lsp-tether-')
    const { bin, pids } = fakeNpx(dir)
    const d = await startStandInDaemon(`
import { LspClient } from ${srcUrl('code/lsp-client.ts')}
void new LspClient({ language: ${JSON.stringify(language)}, languageId: ${JSON.stringify(language)}, npxArgs: ['-y', 'a-language-server', '--stdio'] }, process.cwd()).ensureStarted()
report({ started: true })
setInterval(() => {}, 1e9)
`, { env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
    try {
      await d.next()
      const running = await pidsIn(pids)
      record(...running)
      await d.kill('SIGKILL')
      assert.deepEqual(await waitGone(running, 1000), [], 'npx and its child are gone within 1 s')
    } finally {
      killRecorded(d.pid)
    }
  })
}
