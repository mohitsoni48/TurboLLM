// ConfigStore.read(): the hot-path accessor. Hands out the live config without the
// structuredClone snapshot() pays (~2 ms on a real 830 KB config, several times per request), and is
// deep-frozen so a caller that mutates it throws instead of corrupting the shared state.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigStore } from './config'
import { tmpDir } from '../test-support/tmp'

function withStore(run: (store: ConfigStore) => void): void {
  const dir = tmpDir('tllm-cfg-read-')
  try {
    run(ConfigStore.load(join(dir, 'config.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('read() returns the same object on every call, with no clone', () => {
  withStore((store) => {
    assert.equal(store.read(), store.read())
  })
})

test('read() is deeply frozen: a mutation attempt throws', () => {
  withStore((store) => {
    const cfg = store.read() as unknown as { daemon: { lanBind: boolean }; apiKeys: unknown[] }
    assert.throws(() => { cfg.daemon.lanBind = !cfg.daemon.lanBind }, TypeError)
    assert.throws(() => { cfg.apiKeys.push({}) }, TypeError)
  })
})

test('read() is frozen straight after load, before any update()', () => {
  withStore((store) => {
    assert.ok(Object.isFrozen(store.read()))
  })
})

test('update() still works on a frozen current config, and read() sees the new value', () => {
  withStore((store) => {
    const before = store.read()
    const flipped = !before.daemon.lanBind
    store.update((c) => { c.daemon.lanBind = flipped })
    assert.equal(store.read().daemon.lanBind, flipped)
    assert.notEqual(store.read(), before)
    assert.ok(Object.isFrozen(store.read()))
    // The object read() handed out earlier is a past version, untouched.
    assert.equal(before.daemon.lanBind, !flipped)
  })
})

test('snapshot() is still a mutable copy, independent of read()', () => {
  withStore((store) => {
    const snap = store.snapshot()
    assert.notEqual(snap, store.read())
    assert.ok(!Object.isFrozen(snap))
    const was = snap.daemon.lanBind
    snap.daemon.lanBind = !was
    assert.equal(store.read().daemon.lanBind, was)
  })
})

test('a frozen config survives a reload from disk', () => {
  const dir = tmpDir('tllm-cfg-read-')
  try {
    const path = join(dir, 'config.json')
    const a = ConfigStore.load(path)
    a.update((c) => { c.daemon.lanBind = true })
    assert.equal(ConfigStore.load(path).read().daemon.lanBind, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Review L4: update() froze its working copy in place, and with it every object a caller put into it, which callers
// still hold and change (Registry.add*'s engine, a link record, an API key, an MCP server, a custom agent): a later
// write to their own object threw. The store freezes its own copy instead.
test('an object a caller puts in through update() stays the caller\'s to change, while read() stays frozen', () => {
  withStore((store) => {
    const key = { id: 'k1', name: 'mine' }
    store.update((c) => { (c.apiKeys as unknown[]).push(key) })
    assert.ok(!Object.isFrozen(key))
    key.name = 'renamed'
    const stored = store.read().apiKeys.at(-1) as unknown as { name: string }
    assert.ok(Object.isFrozen(stored))
    assert.equal(stored.name, 'mine', 'the store kept its own copy')
  })
})
