// The log file a detached child's stdout and stderr go to: update.log (the update helper and the
// daemon it relaunches, app-update-apply.ts and update-helper.mjs). A daemon started with
// --print-token or --tunnel prints a fresh API key on every start, so an update wrote that key
// into it. (A Settings restart's replacement used to write to restart.log; it now runs under its
// keeper and writes to the terminal TurboLLM was started from, cli.ts becomeKeeper.)
// Opened with the default mode it was 0644 under the usual umask 022, and in a 0755
// ~/.turbollm (macOS home folders, older Debian/Ubuntu, many servers) every other local account
// could read it, as config.json was before it was made owner-only (config.ts CONFIG_FILE_MODE).
import { fchmodSync, openSync } from 'node:fs'

/** Read and write for the owner only. Windows keeps only the write bit of a mode, so there the
 *  file stays writable and the profile's ACLs protect it, as for config.json. */
export const OWNER_ONLY_LOG_MODE = 0o600

/** Open `path` for appending, owner-only: created with {@link OWNER_ONLY_LOG_MODE}, and an existing
 *  file (an older version's 0644 one) has its mode set to it too, since a mode passed to open
 *  applies only to a file the open creates. Throws when the file can't be opened, as openSync
 *  does; a mode that can't be set (a file another account owns) leaves the open as it is. */
export function openOwnerOnlyLog(path: string): number {
  const fd = openSync(path, 'a', OWNER_ONLY_LOG_MODE)
  try {
    fchmodSync(fd, OWNER_ONLY_LOG_MODE)
  } catch {
    /* best-effort: the log still works */
  }
  return fd
}
