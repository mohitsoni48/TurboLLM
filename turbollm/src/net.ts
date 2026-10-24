import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

/** Adapter-name patterns for virtual/tunnel NICs (Hyper-V/WSL vEthernet, Docker, VPN
 *  clients, etc.) that report a routable-looking, non-internal IPv4 address but are never
 *  reachable from another device on the physical LAN. */
const VIRTUAL_ADAPTER_NAME = /^(vEthernet|Loopback|Virtual|VMware|VirtualBox|Hyper-V|Docker|WSL|Tailscale|ZeroTier|Npcap|TAP-|PPP|Bluetooth)/i

/** Best-effort LAN-facing IPv4 for this machine, or null if none was found.
 *
 *  `os.networkInterfaces()` also reports virtual switches (Hyper-V/WSL, Docker, VPN
 *  clients) as non-internal IPv4 addresses — `iface.internal` is only true for loopback —
 *  and Node/Windows don't guarantee the real Wi-Fi/Ethernet adapter comes first in
 *  enumeration order. Left unfiltered, this silently hands out an address like
 *  `172.22.96.1` (the WSL/Hyper-V vEthernet switch) that only exists between the host and
 *  its VM, never reachable from another device on the LAN. Prefer a candidate whose
 *  adapter name doesn't match a known-virtual pattern; fall back to whatever was found if
 *  every candidate looks virtual. */
export function getLanIp(): string | null {
  const candidates: { name: string; address: string }[] = []
  for (const [name, ifaces] of Object.entries(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) candidates.push({ name, address: iface.address })
    }
  }
  const real = candidates.find((c) => !VIRTUAL_ADAPTER_NAME.test(c.name))
  return (real ?? candidates[0])?.address ?? null
}

/** Operator override for the address this daemon ADVERTISES in the URLs it hands out
 *  (Turbo Link strings, LAN chat-share links). Set `TURBOLLM_ADVERTISED_HOST` to either a
 *  bare host (`llm.example.com`, `192.168.1.50`) or a host:port (`llm.example.com:8443`);
 *  a leading scheme and a trailing slash/path are tolerated and stripped.
 *
 *  Why an env var and not auto-detection: {@link getLanIp}'s virtual-adapter filter fixes
 *  the case where TurboLLM runs on a HOST that also runs Docker/WSL/Hyper-V. It cannot fix
 *  the opposite case — TurboLLM running INSIDE a container, where the only non-internal
 *  IPv4 interface is `eth0` at the container-internal bridge address (e.g. `172.17.0.2`).
 *  That address looks perfectly routable from in here and is reachable from nowhere
 *  outside without Docker's NAT/port-publish translation, which this process has no way to
 *  discover or reverse. The externally-reachable address is genuinely the operator's
 *  knowledge, so the only correct fix is to let them state it.
 *
 *  {@link getLanIp} deliberately stays pure (best-guess LAN IP, no override awareness) —
 *  the override is applied at the URL-minting call sites so nothing that wants the real
 *  local interface address accidentally gets a public hostname instead.
 *
 *  `port` is null when the value named no port, meaning "keep the port I'd otherwise use".
 *  `host` comes back URL-ready: a bare IPv6 literal is returned bracketed. */
export function getAdvertisedHost(): { host: string; port: number | null } | null {
  const raw = process.env.TURBOLLM_ADVERTISED_HOST?.trim()
  if (!raw) return null
  // Tolerate a pasted URL: drop any scheme, then anything from the first `/` on.
  let v = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const slash = v.indexOf('/')
  if (slash >= 0) v = v.slice(0, slash)
  v = v.trim()
  if (!v) return null

  // `[::1]:6996` / `[::1]` — the only unambiguous way to write an IPv6 literal with a port.
  const bracketed = /^(\[[^\]]+\])(?::(\d{1,5}))?$/.exec(v)
  if (bracketed) {
    const port = bracketed[2] ? Number(bracketed[2]) : null
    return { host: bracketed[1], port: port && port > 0 && port <= 65535 ? port : null }
  }
  // A bare IPv6 literal (two or more colons) — no port can be expressed, bracket it for URLs.
  if (v.indexOf(':') !== v.lastIndexOf(':')) return { host: `[${v}]`, port: null }

  const withPort = /^(.+):(\d{1,5})$/.exec(v)
  if (withPort) {
    const port = Number(withPort[2])
    if (port > 0 && port <= 65535) return { host: withPort[1], port }
  }
  return { host: v, port: null }
}

/** The host and port `--addr` names, the host bare as a bind takes it. `[::1]:6996` and `[::1]` are
 *  the unambiguous IPv6 forms. An unbracketed IPv6 address is split on its last colon only when
 *  what follows that colon is a decimal number and what comes before it is an IPv6 address itself
 *  (`::1:6996`, which bound as ::1 port 6996 before), and is otherwise the whole host (`::1`,
 *  `fe80::1`, `fd00::abc:def`, `::ffff:127.0.0.1`: a last group with a hex letter or a dot is never
 *  a port). The split on the last colon alone handed serve() the hostname `[::1]`, which no lookup
 *  resolves, so the daemon exited at boot, and turned `::1` into the host `:`; a host with no port
 *  (`0.0.0.0`) lost its last character. No port, or one that is not a number, is 6996; no host is
 *  127.0.0.1, as before. */
export function parseListenAddr(addr: string): { host: string; port: number } {
  const port = (s: string | undefined): number => Number(s) || 6996
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(addr)
  if (bracketed) return { host: bracketed[1] || '127.0.0.1', port: port(bracketed[2]) }
  const last = addr.lastIndexOf(':')
  if (last < 0) return { host: addr || '127.0.0.1', port: 6996 }
  const head = addr.slice(0, last)
  const tail = addr.slice(last + 1)
  // Two colons or more: an IPv6 address, with a port only in the `::1:6996` form. `fd00::abc:def`
  // and `fe80::1:abcd` were split into fd00::abc and fe80::1, another address, on port 6996.
  if (head.includes(':') && !(/^\d+$/.test(tail) && isIP(head) === 6)) return { host: addr, port: 6996 }
  return { host: head || '127.0.0.1', port: port(tail) }
}
