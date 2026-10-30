// The daemon's recurring ticks that no component of its own stops: the telemetry flushes and rollups (cli.ts), the ext
// API's reaper (server.ts) and the terminals' idle sweep (terminal/terminal-manager.ts).
//
// A Settings restart from a terminal keeps the old process as the keeper of its replacement (cli.ts becomeKeeper),
// and each of these ran on in it, on the old process's state: the ext reaper's audit prune ran on the chat store the
// keeper had closed, threw from its timer ("database is not open") and ended the keeper, and with it TurboLLM (the
// replacement's stdin lifeline ended), 30 s after every such restart with the ext API on; the telemetry ticks flushed
// the queue with the consent from before the restart, and rewrote the daily-usage files from the keeper's stale
// counts. The keeper stops every one of them (stopDaemonTicks) before it starts its replacement. A recurring tick of
// a component that has a stop of its own (the routine and update schedulers, the Turbo Link poll, the usage monitor,
// a tunnel's health loop, an engine's idle watchdog) is stopped by the restart or the keeper through it instead
// (util/daemon-ticks.test.ts lists every one).
//
// Unref'd, as each of them was: none keeps the process alive on its own.
const ticks = new Set<ReturnType<typeof setInterval>>()

/** setInterval for a tick of the daemon's own, unref'd, which the restart keeper stops. */
export function daemonTick(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  const t = setInterval(fn, ms)
  t.unref()
  ticks.add(t)
  return t
}

/** For the restart keeper: every daemonTick stopped. */
export function stopDaemonTicks(): void {
  for (const t of ticks) clearInterval(t)
  ticks.clear()
}
