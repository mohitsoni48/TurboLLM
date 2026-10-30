// A stdio MCP server runs through util/tether.ts: it and whatever it starts end the moment the daemon does, and a
// disconnect ends its whole group. Before, only TurboLLM's own teardown or a disconnect killed it, and only the
// server's own pid: a daemon that died without a teardown left a server that does not exit on its stdin's EOF
// running, parented to init, and a server's own child outlived any disconnect.
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { StdioMcpClient } from './mcp-client'
import { killRecorded, record, srcUrl, startStandInDaemon, waitGone, writtenTo } from '../test-support/stand-in-daemon'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'a POSIX shell stand-in (Windows runs the server through cmd.exe)' : false

/** A stand-in server: starts a child, answers initialize, then never reads its stdin again (so its EOF is ignored). */
function standInServer(dir: string): { command: string; pids: string } {
  const pids = join(dir, 'server.pids')
  const command = join(dir, 'server.sh')
  writeFileSync(command, [
    '#!/bin/sh',
    'sleep 300 &',
    `echo "$$ $!" > ${pids}`,
    'read -r _',
    `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{}}}'`,
    'exec sleep 301',
    '',
  ].join('\n'))
  chmodSync(command, 0o755)
  return { command, pids }
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

test('a daemon SIGKILLed with a stdio MCP server connected takes the server and its child with it', { skip }, async () => {
  const dir = tmpDir('tllm-mcp-tether-')
  const { command, pids } = standInServer(dir)
  const d = await startStandInDaemon(`
import { StdioMcpClient } from ${srcUrl('tools/mcp-client.ts')}
const client = new StdioMcpClient({ id: 's', name: 's', command: ${JSON.stringify(command)} })
await client.connect()
report({ connected: true })
setInterval(() => {}, 1e9)
`)
  try {
    await d.next()
    const running = await pidsIn(pids)
    record(...running)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone(running, 1000), [], 'the server (it ignores its stdin\'s EOF) and its child are gone within 1 s')
  } finally {
    killRecorded(d.pid)
  }
})

test('disconnect() ends the server and what it started', { skip }, async () => {
  const dir = tmpDir('tllm-mcp-disconnect-')
  const { command, pids } = standInServer(dir)
  const client = new StdioMcpClient({ id: 's', name: 's', command })
  let running: number[] = []
  try {
    await client.connect()
    running = await pidsIn(pids)
    record(...running)
    client.disconnect()
    assert.deepEqual(await waitGone(running, 2000), [], 'the server and its child are gone')
  } finally {
    client.disconnect()
    killRecorded(...running)
  }
})
