// StdioMcpClient's lazy reconnect: a failed initialize kills the server process (it is not
// awaited) and the next listTools/callTool spawns a replacement. Each process's exit/error/stdout
// handlers must act only for that process: a late 'exit' from the old one used to run cleanup()
// on the client, killing the REPLACEMENT mid-initialize and failing its requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { StdioMcpClient } from './mcp-client'
import { tmpDir } from '../test-support/tmp'

// A tiny stdio MCP server. Spawn #1 refuses initialize and, like a server that shuts down slowly
// (an npx/uvx wrapper forwarding the signal), exits only 300 ms after SIGTERM. Every later spawn
// answers initialize after 800 ms, so the old one's exit lands while the new one initializes.
const SERVER = `
const fs = require('fs')
const countFile = process.argv[2]
const n = (Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) || 0) + 1
fs.writeFileSync(countFile, String(n))
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300))
process.stdin.on('end', () => process.exit(0))
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  const lines = buf.split('\\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id == null) continue
    if (m.method === 'initialize') {
      if (n === 1) send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unsupported' } })
      else setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: {} }), 800)
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo' }] } })
    } else if (m.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } })
    }
  }
})
`

test("an old server process's late exit/error/stdout never touches its lazily spawned replacement", async () => {
  const dir = tmpDir('turbollm-mcp-client-')
  const script = join(dir, 'server.cjs')
  const countFile = join(dir, 'spawns')
  writeFileSync(script, SERVER)
  // On Windows the client runs the command through `cmd.exe /c`, so use node from PATH there.
  const command = process.platform === 'win32' ? 'node' : process.execPath
  const client = new StdioMcpClient({ id: 's', name: 's', command, args: [script, countFile] })
  const procOf = () => (client as unknown as { proc: ChildProcess | null }).proc
  try {
    const first = client.connect()
    const old = procOf()
    assert.ok(old)
    await assert.rejects(first, /unsupported/)
    assert.equal(procOf(), null, 'a failed initialize cleans up')

    // The lazy reconnect: spawns the replacement while the old process is still shutting down.
    assert.deepEqual((await client.listTools()).map((t) => t.name), ['echo'])
    const replacement = procOf()
    assert.ok(replacement && replacement !== old)

    // Whatever the old process still delivers is ignored: a (repeated) exit, an error, and a
    // partial stdout line that would otherwise prefix the replacement's next response.
    old.emit('exit', 0, null)
    old.emit('error', new Error('stale'))
    old.stdout?.emit('data', Buffer.from('{"jsonrpc":"2.0","partial'))
    assert.equal(await client.callTool('echo', {}), 'pong')
    assert.equal(procOf(), replacement, 'the replacement is still the live process')
    assert.equal(readFileSync(countFile, 'utf8'), '2', 'no third spawn')
  } finally {
    client.disconnect()
  }
})

// Answers tools/call with 3 000 '€' (E2 82 AC), written in two parts with a pause between them and
// the split falling inside one '€', so the client's stdout handler gets the character in two chunks.
const SPLIT_SERVER = `
const send = (s) => process.stdout.write(s)
let buf = ''
process.stdin.on('end', () => process.exit(0))
process.stdin.on('data', (c) => {
  buf += c
  const lines = buf.split('\\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id == null) continue
    if (m.method !== 'tools/call') { send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n'); continue }
    const out = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '€'.repeat(3000) }] } }) + '\\n')
    const cut = out.indexOf(Buffer.from('€')) + 3 * 1500 + 1
    send(out.subarray(0, cut))
    setTimeout(() => send(out.subarray(cut)), 100)
  }
})
`

test('a tool result whose multibyte characters straddle stdout chunks reaches the caller unaltered', async () => {
  const dir = tmpDir('turbollm-mcp-client-')
  const script = join(dir, 'split-server.cjs')
  writeFileSync(script, SPLIT_SERVER)
  const command = process.platform === 'win32' ? 'node' : process.execPath
  const client = new StdioMcpClient({ id: 's', name: 's', command, args: [script] })
  try {
    const text = await client.callTool('t', {})
    assert.equal(text.includes('�'), false, 'no U+FFFD where a chunk boundary split a character')
    assert.equal(text, '€'.repeat(3000))
  } finally {
    client.disconnect()
  }
})
