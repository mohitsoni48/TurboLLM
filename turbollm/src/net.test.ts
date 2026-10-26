import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getAdvertisedHost, getLanIp, parseListenAddr } from './net'

// TURBOLLM_ADVERTISED_HOST exists for the one case auto-detection provably cannot solve:
// TurboLLM running INSIDE a Docker container, where the only non-internal IPv4 interface
// is `eth0` at the container-internal bridge address (172.17.0.2). That address is
// unreachable from outside without Docker's NAT/port-publish translation, which this
// process cannot discover or reverse — so the operator states the real address instead.

/** Set the override for the duration of `fn`, restoring whatever was there before. */
function withAdvertisedHost<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.TURBOLLM_ADVERTISED_HOST
  if (value === undefined) delete process.env.TURBOLLM_ADVERTISED_HOST
  else process.env.TURBOLLM_ADVERTISED_HOST = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TURBOLLM_ADVERTISED_HOST
    else process.env.TURBOLLM_ADVERTISED_HOST = prev
  }
}

test('getAdvertisedHost: unset → null (auto-detection stays in charge)', () => {
  assert.equal(withAdvertisedHost(undefined, getAdvertisedHost), null)
})

test('getAdvertisedHost: blank / whitespace-only is treated as unset, not as an empty host', () => {
  assert.equal(withAdvertisedHost('', getAdvertisedHost), null)
  assert.equal(withAdvertisedHost('   ', getAdvertisedHost), null)
})

test('getAdvertisedHost: a bare host keeps the port the caller would otherwise use', () => {
  assert.deepEqual(withAdvertisedHost('llm.example.com', getAdvertisedHost), { host: 'llm.example.com', port: null })
  assert.deepEqual(withAdvertisedHost('192.168.1.50', getAdvertisedHost), { host: '192.168.1.50', port: null })
})

test('getAdvertisedHost: host:port names the published port, which need not match the bound one', () => {
  // The Docker case exactly: bound :6996 inside, published :8443 outside.
  assert.deepEqual(withAdvertisedHost('192.168.1.50:8443', getAdvertisedHost), { host: '192.168.1.50', port: 8443 })
})

test('getAdvertisedHost: a pasted URL is tolerated — scheme and path are stripped', () => {
  assert.deepEqual(withAdvertisedHost('http://llm.example.com:8443/', getAdvertisedHost), { host: 'llm.example.com', port: 8443 })
  assert.deepEqual(withAdvertisedHost('https://llm.example.com', getAdvertisedHost), { host: 'llm.example.com', port: null })
})

test('getAdvertisedHost: surrounding whitespace is trimmed', () => {
  assert.deepEqual(withAdvertisedHost('  192.168.1.50:8443  ', getAdvertisedHost), { host: '192.168.1.50', port: 8443 })
})

test('getAdvertisedHost: a bracketed IPv6 literal keeps its brackets and parses its port', () => {
  assert.deepEqual(withAdvertisedHost('[fd00::1]:6996', getAdvertisedHost), { host: '[fd00::1]', port: 6996 })
  assert.deepEqual(withAdvertisedHost('[fd00::1]', getAdvertisedHost), { host: '[fd00::1]', port: null })
})

test('getAdvertisedHost: a BARE IPv6 literal is bracketed for URL use, never split on its last colon', () => {
  // `fd00::1` must not be read as host `fd00:` port `1`.
  assert.deepEqual(withAdvertisedHost('fd00::1', getAdvertisedHost), { host: '[fd00::1]', port: null })
})

test('getAdvertisedHost: an out-of-range port is not parsed as a port — the value is left whole', () => {
  // Deliberately NOT silently dropped: a nonsense port stays visible in the URL the
  // operator sees, rather than quietly becoming a plausible-looking wrong address.
  assert.deepEqual(withAdvertisedHost('llm.example.com:99999', getAdvertisedHost), { host: 'llm.example.com:99999', port: null })
  assert.deepEqual(withAdvertisedHost('llm.example.com:0', getAdvertisedHost), { host: 'llm.example.com:0', port: null })
})

test('getLanIp stays pure — the override never leaks into it', () => {
  // getLanIp must keep answering "the best-guess address of a real local interface";
  // the override is applied at the URL-minting call sites, not here.
  const withOverride = withAdvertisedHost('203.0.113.7', getLanIp)
  const without = withAdvertisedHost(undefined, getLanIp)
  assert.equal(withOverride, without)
  assert.notEqual(withOverride, '203.0.113.7')
})

// --addr was split on its last colon: `[::1]:6996` bound the hostname `[::1]` (no lookup resolves
// it: the daemon exited), `::1` became the host `:` with port 1, and `0.0.0.0` (no port) bound
// `0.0.0.`. The host comes back bare, as serve() binds it.
test('parseListenAddr: IPv6 with or without brackets, a host without a port, and the old forms', () => {
  const cases: [string, string, number][] = [
    ['127.0.0.1:6996', '127.0.0.1', 6996],
    ['0.0.0.0:7000', '0.0.0.0', 7000],
    ['localhost:7000', 'localhost', 7000],
    [':7000', '127.0.0.1', 7000],
    ['0.0.0.0', '0.0.0.0', 6996],
    ['127.0.0.1:junk', '127.0.0.1', 6996],
    ['[::1]:7000', '::1', 7000],
    ['[::1]', '::1', 6996],
    ['[::]:7000', '::', 7000],
    ['[]:7000', '127.0.0.1', 7000],
    ['::1:7000', '::1', 7000], // what bound as ::1 port 7000 before still does
    ['::1', '::1', 6996],
    ['::', '::', 6996],
    ['fe80::1', 'fe80::1', 6996],
    ['2001:db8::1', '2001:db8::1', 6996],
    // A last group with a hex letter or a dot is part of the address, never a port: these became
    // fd00::abc, fe80::1 and ::ffff, other addresses, on 6996.
    ['fd00::abc:def', 'fd00::abc:def', 6996],
    ['fe80::1:abcd', 'fe80::1:abcd', 6996],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1', 6996],
    ['::ffff:127.0.0.1:7000', '::ffff:127.0.0.1', 7000],
    ['[fd00::abc:def]:7000', 'fd00::abc:def', 7000],
  ]
  for (const [addr, host, port] of cases) assert.deepEqual(parseListenAddr(addr), { host, port }, addr)
})
