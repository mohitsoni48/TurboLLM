// Windows console-flash fix.
//
// On Windows, a child process spawned by a parent that has NO attached console
// (e.g. the daemon after a detached self-restart, or when launched via a GUI
// shortcut) gets its OWN console window unless `windowsHide: true` is set. The
// agent engine runs on the external pi SDK, whose shell tool spawns commands
// WITHOUT windowsHide — so every bash step the agent runs flashes a cmd window.
// We can't edit that third-party code, and it does a *named* `import { spawn }`,
// so reassigning `child_process.spawn` wouldn't reach its binding.
//
// Every spawn path in Node — spawn(), execFile(), exec(), fork() — funnels
// through the shared `ChildProcess.prototype.spawn(options)`, which is where
// `options.windowsHide` is actually read. Patching that one method covers ALL
// in-process spawns regardless of how the high-level function was imported,
// because they construct the same builtin ChildProcess and call .spawn(opts) at
// call time.
//
// We FORCE windowsHide=true (not merely default it): the public spawn() has
// already normalized the option to `false` by the time it reaches this method,
// so an undefined-check would never fire and we can't distinguish "caller left
// it default" from "caller asked for false". That's fine — the daemon is a
// background service, so no child it spawns (engine binaries, git/cmake, the pi
// SDK's shell tool, the browser launcher, the detached self-restart) should ever
// pop its own console window.
import { ChildProcess } from 'node:child_process'

let installed = false

/** Force `windowsHide: true` for every child process on Windows so a console-less
 *  daemon doesn't flash a window per spawn. No-op on other platforms; idempotent. */
export function hideChildConsoleWindows(): void {
  if (installed || process.platform !== 'win32') return
  installed = true

  const proto = ChildProcess.prototype as unknown as {
    spawn: (options: Record<string, unknown>) => unknown
  }
  const original = proto.spawn
  proto.spawn = function patchedSpawn(options) {
    if (options) options.windowsHide = true
    return original.call(this, options)
  }
}
