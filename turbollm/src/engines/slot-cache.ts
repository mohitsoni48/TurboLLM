// ⚠️ PARKED (ADR-053): this feature is implemented and unit-tested but intentionally NOT
// exposed in the product — there is no Settings toggle and `comfyui.cachePersist` is not
// writable via the settings API, so it defaults off and the wiring below is never reached
// in normal use. It only helps text-only llama.cpp models (vision models 501 on multimodal
// slot-save, and the user's primary models are all vision), so the value didn't justify a
// user-facing switch. The code is kept (and still tested) so it can be re-enabled later by
// restoring the Settings toggle + the `/settings` PATCH write. Reachable today only by
// hand-editing `comfyui.cachePersist: true` in config.json.
//
// KV prompt-cache persistence across a ComfyUI-forced unload/reload (F-014). When the
// ComfyUI guard force-kills llama-server to free VRAM, it evicts not just the model but
// the whole KV/prompt cache — so on reload the long stable prefix (an agentic
// system+tools prompt, or a long chat) has to be re-prefilled, which is slow. These
// helpers let the guard SAVE that cache to disk before the unload and RESTORE it after
// the reload, turning the expensive re-prefill into a cheap memcpy.
//
// llama-server exposes this via slot persistence: launched with `--slot-save-path <DIR>`,
// `POST {base}/slots/0?action=save` writes `<DIR>/<filename>` and
// `POST {base}/slots/0?action=restore` memcpy's it back (no recompute). The save FILE
// survives the process being killed, so a NEW server started later with the same
// `--slot-save-path` + identical args can restore it — exactly our swap cycle. llama.cpp
// hard-checks restore validity against the model + ctx-size + cache-type-k/-v + parallel
// + flash-attn; our reload reuses the IDENTICAL StartOpts so this matches by construction,
// and we additionally key the filename on those args (below) for defence in depth.
//
// Constraints we honour here: text-only (multimodal save returns HTTP 501 → skip vision),
// llama.cpp-only (vLLM/MLX have no cross-restart persistence → skip), single stream
// (`--parallel 1`, the only shape whose slot-0 cache is the whole conversation). The save
// is CAPPED (see SAVE_CAP_MS): it holds VRAM until the write finishes, delaying ComfyUI,
// so if it doesn't complete within the cap we abort and free VRAM immediately — ComfyUI
// is never delayed beyond the cap, we simply skip the cache that cycle.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { StartOpts } from './manager'

/** The subset of `fetch` the slot endpoints need — same injectable shape as the guard's
 *  {@link FetchImpl}, so tests can assert the POSTs without hitting llama-server. */
export type SlotHttp = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>

/** Hard cap on the pre-unload save (ms). The save holds VRAM until the write completes,
 *  delaying ComfyUI — so we abort it past this and free VRAM immediately (no cache that
 *  cycle). Override with TURBOLLM_SLOT_CACHE_SAVE_CAP_MS. */
export const SAVE_CAP_MS = (() => {
  const v = Number(process.env.TURBOLLM_SLOT_CACHE_SAVE_CAP_MS)
  return Number.isFinite(v) && v > 0 ? v : 2500
})()

/** How long a saved cache file stays usable before {@link sweepExpired} prunes it. A stale
 *  cache wastes disk and can never help (the prefix has long since changed). Override with
 *  TURBOLLM_SLOT_CACHE_TTL_MIN (minutes). */
export const TTL_MS = (() => {
  const v = Number(process.env.TURBOLLM_SLOT_CACHE_TTL_MIN)
  return Number.isFinite(v) && v > 0 ? v * 60_000 : 60 * 60_000
})()

/** Where the saved slot files live: a `slot-cache` dir under the daemon data dir. Passed
 *  to llama-server as `--slot-save-path` and used here for sweeps/deletes. Never an
 *  arbitrary system path — always under the discoverable data dir (cross-platform). */
export function slotCacheDir(dataDir: string): string {
  return join(dataDir, 'slot-cache')
}

/** A short, stable BARE filename (`slot-<hash>.bin`, no path/slashes — the server prepends
 *  the slot-save-path) keyed on the things that must match for a restore to be valid:
 *  the model path, the launch args (which already encode ctx / `--cache-type-*` /
 *  `--flash-attn` / `--parallel`), and the engine version (so a llama.cpp upgrade that
 *  changes the on-disk format invalidates old files). Same opts → same name (the reload
 *  finds its own file); any difference → a different name (we never restore a mismatched
 *  cache, which llama.cpp would reject anyway). */
export function slotCacheKey(opts: StartOpts): string {
  const material = `${opts.modelPath}\0${opts.extraArgs.join(' ')}\0${opts.engine.version}`
  const hash = createHash('sha256').update(material).digest('hex').slice(0, 16)
  return `slot-${hash}.bin`
}

/** True when `--parallel` is absent (server default is 1) or set to exactly '1'. Slot 0's
 *  cache is the whole conversation only with a single stream; multi-stream layouts split
 *  the KV across slots, so persisting slot 0 alone would be wrong — skip them. */
function parallelIsOne(extraArgs: string[]): boolean {
  const i = extraArgs.indexOf('--parallel')
  if (i === -1) return true
  return extraArgs[i + 1] === '1'
}

/** Whether this load is a candidate for KV persistence at all: the feature is on
 *  (ComfyUI coordination enabled + the opt-in toggle), the engine is llama.cpp (the only
 *  one with cross-restart slot persistence), the model is text-only (multimodal save
 *  501s), and it's a single stream (slot 0 == the whole conversation). */
export function cacheEligible(opts: StartOpts, cfg: { enabled: boolean; cachePersist: boolean }): boolean {
  return (
    cfg.enabled &&
    cfg.cachePersist &&
    opts.engine.kind === 'llama-server' &&
    !opts.model.vision &&
    parallelIsOne(opts.extraArgs)
  )
}

/** Prune saved slot files older than `ttlMs` (by mtime). Best-effort: a missing dir or an
 *  unreadable/locked file is swallowed — pruning must never block or throw. Called before
 *  each save so stale caches don't accumulate. */
export function sweepExpired(dir: string, ttlMs: number, now: number): void {
  if (!existsSync(dir)) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!/^slot-.*\.bin$/.test(name)) continue
    const full = join(dir, name)
    try {
      if (now - statSync(full).mtimeMs > ttlMs) rmSync(full, { force: true })
    } catch {
      /* locked/vanished — skip it */
    }
  }
}

/** How many saves of each cache file (by its full path) this process has started. A save names the same file as the
 *  one before it whenever the model and its launch args are the same, so restoreSlot deletes the file it restored only
 *  when no save of it has started since the restore began (see there). */
const savesStarted = new Map<string, number>()

/** Save the running model's slot-0 KV cache to disk before the ComfyUI-forced unload.
 *  Capped by `capMs` (see {@link SAVE_CAP_MS}) — if the server doesn't finish the write in
 *  time we abort so VRAM frees immediately. Fully fail-safe: a timeout, an HTTP 501
 *  (multimodal — shouldn't reach here, but defensive), or an unreachable server all return
 *  false (no cache this cycle) rather than throwing, so the unload always proceeds. */
export async function saveSlot(p: {
  http: SlotHttp
  base: string
  dir: string
  filename: string
  capMs: number
  ttlMs: number
  now: number
}): Promise<boolean> {
  sweepExpired(p.dir, p.ttlMs, p.now)
  const file = join(p.dir, p.filename)
  // Noted before the request: the server may write the file before its answer reaches us.
  savesStarted.set(file, (savesStarted.get(file) ?? 0) + 1)
  try {
    console.log(`[slot-cache] saving the prompt cache before ComfyUI takes the GPU (cap ${p.capMs}ms).`)
    const res = await p.http(`${p.base}/slots/0?action=save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: p.filename }),
      signal: AbortSignal.timeout(p.capMs),
    })
    if (!res.ok) {
      console.warn(`[slot-cache] save returned ${res.status} — skipping the cache this cycle.`)
      return false
    }
    return true
  } catch (e) {
    // Timeout (hit the cap), 501 (multimodal), or server down — non-fatal. Free VRAM now.
    console.warn(`[slot-cache] could not save the prompt cache (${e instanceof Error ? e.message : e}) — skipping it this cycle.`)
    return false
  }
}

/** Restore a previously-saved slot-0 KV cache after the model reloads, skipping the
 *  re-prefill. On success the file is deleted (it's single-use — the live cache is now
 *  back in VRAM) and we return true; any failure (mismatch HTTP error, server down) is
 *  swallowed and returns false so the reload is otherwise unaffected.
 *  Not deleted when a save of the same file started while the restore ran: the next ComfyUI prompt's acquire saves
 *  the reloaded engine's cache under the same name, for its own release to restore, and can do so while a slow restore
 *  is still in flight (the release route answers before the reload). Deleting it then left that release nothing to
 *  restore. */
export async function restoreSlot(p: { http: SlotHttp; base: string; dir: string; filename: string }): Promise<boolean> {
  const file = join(p.dir, p.filename)
  const saves = savesStarted.get(file) ?? 0
  try {
    console.log('[slot-cache] restoring the prompt cache after the ComfyUI reload (skipping the re-prefill).')
    const res = await p.http(`${p.base}/slots/0?action=restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: p.filename }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.warn(`[slot-cache] restore returned ${res.status} — the prompt will be re-prefilled normally.`)
      return false
    }
    try {
      if ((savesStarted.get(file) ?? 0) === saves) rmSync(file, { force: true })
    } catch {
      /* best-effort cleanup; a leftover file is pruned by the TTL sweep anyway */
    }
    return true
  } catch (e) {
    console.warn(`[slot-cache] could not restore the prompt cache (${e instanceof Error ? e.message : e}) — re-prefilling normally.`)
    return false
  }
}
