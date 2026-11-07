// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Deps } from '../deps'
import { isLocalRequest } from '../auth'
import { err } from './http'

/** The local filesystem browser and git info for the Code repo picker. */
export function registerFsRoutes(app: Hono, d: Deps): void {
  // ---- filesystem browser (spec 03 §9): pick an engine binary/folder by navigating
  // the disk from the browser. LOCAL-ONLY (isLocalRequest) — deliberately STAYS stricter than
  // /engines/scan post-ADR-394: this is arbitrary filesystem disclosure (every folder/file name
  // under wherever the browse lands), a different threat than probing one caller-named binary,
  // so a page on the LAN — even with a valid key — still cannot read the filesystem through the
  // daemon; only the browser on the machine running TurboLLM can. Deliberately NOT
  // home-confined, so an engine that lives on another drive (D:\) or outside home is
  // reachable — the local user already picks (and executes) arbitrary binaries via scan.
  app.get('/api/v1/fs/browse', (c) => {
    if (!isLocalRequest(c, d))
      return err(c, 403, 'forbidden', 'Browsing the filesystem is only available on the machine running TurboLLM.')
    const raw = (c.req.query('path') ?? '').trim()
    // Windows "This PC": a virtual root above the drive letters, so the user can hop
    // between drives (C:\, D:\, …). Reached by going "up" from a drive root.
    if (raw === FS_DRIVES_ROOT && process.platform === 'win32') {
      return c.json({ path: FS_DRIVES_ROOT, parent: null, entries: listWindowsDrives() })
    }
    // Default to the home dir (a sensible starting point); any path is allowed.
    const target = raw ? resolve(raw) : homedir()
    // Canonicalize symlinks; fall back to the lexical path if it doesn't exist yet
    // (it then fails the readdir below cleanly).
    let real: string
    try {
      real = realpathSync(target)
    } catch {
      real = target
    }
    let entries: { name: string; path: string; isDir: boolean }[]
    try {
      entries = readdirSync(real, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.')) // hide dotfiles
        .map((d) => {
          // A dirent can be a symlink — resolve its target type so symlinked dirs
          // still navigate. Errors (dangling links) fall back to file.
          let isDir = d.isDirectory()
          if (d.isSymbolicLink()) {
            try {
              isDir = statSync(join(real, d.name)).isDirectory()
            } catch {
              isDir = false
            }
          }
          return { name: d.name, path: join(real, d.name), isDir }
        })
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    } catch {
      return err(c, 400, 'fs_read_failed', 'Could not read that folder (permission denied or not a directory).')
    }
    // Parent: the containing dir; at a filesystem/drive root, go up to the Windows drive
    // list (so the user can switch drives) or stop (null) on a single-root OS.
    const parentDir = dirname(real)
    const parent =
      parentDir === real ? (process.platform === 'win32' ? FS_DRIVES_ROOT : null) : parentDir
    return c.json({ path: real, parent, entries })
  })

  // ---- git info for the Code repo picker: current branch + known local branches ----
  // LOCAL-ONLY, same gate as fs/browse — a LAN client never gets to run git on this
  // machine's disk. Best-effort: any folder that isn't a git repo (or has no commits
  // yet) just reports isRepo:false rather than erroring, so the picker still works for
  // a plain scratch folder.
  app.get('/api/v1/fs/git-branch', (c) => {
    if (!isLocalRequest(c, d))
      return err(c, 403, 'forbidden', 'Reading git info is only available on the machine running TurboLLM.')
    const raw = (c.req.query('path') ?? '').trim()
    if (!raw) return err(c, 400, 'invalid_input', 'path is required.')
    const cwd = resolve(raw)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return c.json({ isRepo: false, branch: '', branches: [] })
    }
    const git = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim()
    try {
      // Confirms we're inside a real work tree (not just a bare/.git dir).
      if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return c.json({ isRepo: false, branch: '', branches: [] })
      let branch = ''
      try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) } catch { /* unborn HEAD (no commits yet) */ }
      if (branch === 'HEAD') branch = '' // detached HEAD — no meaningful branch name
      let branches: string[] = []
      try {
        branches = git(['branch', '--format=%(refname:short)']).split('\n').map((s) => s.trim()).filter(Boolean)
      } catch { /* no branches yet */ }
      return c.json({ isRepo: true, branch, branches })
    } catch {
      return c.json({ isRepo: false, branch: '', branches: [] })
    }
  })
}

/** Sentinel path for the Windows "This PC" drive list — a virtual root above the
 *  drive letters (C:\, D:\, …) so the browser can hop between drives. */
const FS_DRIVES_ROOT = '::drives'

/** Available Windows drive roots (C:\, D:\, …) as browsable entries. Probes A–Z;
 *  only the drives that exist on the box respond, missing ones are skipped. */
function listWindowsDrives(): { name: string; path: string; isDir: boolean }[] {
  const drives: { name: string; path: string; isDir: boolean }[] = []
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`
    try {
      if (existsSync(root)) drives.push({ name: root, path: root, isDir: true })
    } catch {
      /* unreadable drive (e.g. an empty removable slot) — skip */
    }
  }
  return drives
}
