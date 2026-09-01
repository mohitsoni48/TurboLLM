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
