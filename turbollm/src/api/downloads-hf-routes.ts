// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Context, Hono } from 'hono'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { Deps } from '../deps'
import { isLocalOrAuthenticated } from '../auth'
import { HfError, type HfSearchItem, type HfSortOption } from '../hf/hf'
import { TEXT_CLASSIFICATION_CATEGORY } from '../hf/text-classification-search'
import type { EnqueueInput } from '../downloads/downloads'
import { enqueueDownload, listDownloads, removeDownload, toDownloadFailure } from '../services/download-lifecycle'
import { annotateCheckpoint } from '../hf/checkpoints'
import { litertlmHost, litertlmRunsHere } from '../models/litertlm'
import { err, body, regErr, type Status } from './http'

/** Model folders, Hugging Face search and repo detail, and the download queue. */
export function registerDownloadsHfRoutes(app: Hono, d: Deps): void {
  // ---- model directories (spec 02 §5; primary dir spec 01 §3 / ADR-035) ----
  // Adding, removing or choosing a model folder is a host-side change held to
  // isLocalOrAuthenticated, like MCP servers and builds. The primary folder is where every
  // download is written, and a download with a subdir keeps the name its URL ends in, so a
  // keyless Serve identity, Access JWT or open-LAN peer (or a DNS-rebinding page on an open LAN)
  // could add any existing folder (the home folder), make it primary and download
  // ~/.ssh/authorized_keys or ~/.bashrc over the owner's: code execution as the daemon user. The
  // same reach let DELETE /models/:key remove whatever the scanner takes for a model anywhere on
  // disk. api_key_required: the web client opens its key prompt on it. The list stays open.
  const MODEL_DIRS_KEY_REQUIRED = 'Changing the model folders requires a valid API key.'
  app.get('/api/v1/modeldirs', (c) => c.json(modelDirsPayload(d)))

  app.post('/api/v1/modeldirs', async (c) => {
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'api_key_required', MODEL_DIRS_KEY_REQUIRED)
    const b = await body<{ dir?: string }>(c)
    const dir = (b.dir ?? '').trim()
    if (!dir || !/^([a-zA-Z]:[\\/]|[\\/])/.test(dir)) return err(c, 400, 'invalid_config_value', 'Path must be absolute.')
    if (!existsSync(dir)) return err(c, 400, 'invalid_config_value', 'That folder does not exist.')
    try {
      d.store.update((cfg) => {
        if (!cfg.modelDirs.includes(dir)) cfg.modelDirs.push(dir)
      })
    } catch (e) {
      return regErr(c, e)
    }
    void d.scanner.rescan()
    return c.json(modelDirsPayload(d), 201)
  })

  app.delete('/api/v1/modeldirs', async (c) => {
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'api_key_required', MODEL_DIRS_KEY_REQUIRED)
    const b = await body<{ dir?: string }>(c)
    d.store.update((cfg) => {
      cfg.modelDirs = cfg.modelDirs.filter((x) => x !== b.dir)
      // If the removed folder was the configured primary, reset to the effective
      // default (first remaining dir). validate() also guards this on load.
      if (cfg.primaryModelDir === b.dir) cfg.primaryModelDir = ''
    })
    void d.scanner.rescan()
    return c.json(modelDirsPayload(d))
  })

  // Set the primary download/import folder. Must be one of the configured dirs.
  app.post('/api/v1/modeldirs/primary', async (c) => {
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'api_key_required', MODEL_DIRS_KEY_REQUIRED)
    const b = await body<{ dir?: string }>(c)
    const dir = (b.dir ?? '').trim()
    if (!dir || !d.store.snapshot().modelDirs.includes(dir)) {
      return err(c, 400, 'invalid_config_value', 'Primary folder must be one of your model folders.')
    }
    d.store.update((cfg) => {
      cfg.primaryModelDir = dir
    })
    return c.json(modelDirsPayload(d))
  })

  // ── Hugging Face discovery (spec 10 §2–4, §7 rewrite) ────────────────────
  // Search (q set) or browse (q blank — the live equivalent of
  // huggingface.co/models?library=<engine-adapted>&sort=<sort>, replacing what used to be
  // a hardcoded "Featured" list) HF repos. `localCount` is overlaid from the scan cache so
  // a row can show a "↓ N in library" chip without a second round-trip.
  const SORT_OPTIONS: HfSortOption[] = ['best-match', 'trending', 'downloads', 'likes', 'modified', 'created']
  app.get('/api/v1/hf/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    const rawSort = c.req.query('sort') ?? ''
    const sort: HfSortOption = (SORT_OPTIONS as string[]).includes(rawSort) ? (rawSort as HfSortOption) : 'best-match'
    try {
      const results = await searchHf(d, q, sort, c.req.query('category'))
      const withLocal = results.map((r) => ({ ...r, localCount: localCountFor(d, r.repo) }))
      return c.json({ results: withLocal })
    } catch (e) {
      return hfErr(c, e)
    }
  })

  // Repo detail (files + sizes + gated). The id contains a '/', so capture the
  // wildcard tail. Each file is annotated `downloaded` + `localKey` so the SAME
  // model+quant from a different repo is correctly NOT marked downloaded. Two
  // signals (spec 10 §3): (1) download provenance for files pulled via TurboLLM
  // (sha256 exact, or repo+filename); (2) for imported / pre-existing files with
  // no provenance, a content sha256 match — computed lazily and only for a local file
  // whose byte size exactly matches a repo file (so we almost never hash). While a
  // hash is still being computed the response carries `verifying:true` and the UI
  // re-polls until the badge resolves.
  app.get('/api/v1/hf/models/:owner/:name', async (c) => {
    const repo = `${c.req.param('owner')}/${c.req.param('name')}`
    try {
      const detail = await d.hf.getRepo(repo)
      const prov = d.downloads.provenance()
      const models = d.scanner.list().models
      const bySize = new Map<number, typeof models>()
      for (const m of models) {
        const arr = bySize.get(m.sizeBytes) ?? []
        arr.push(m)
        bySize.set(m.sizeBytes, arr)
      }

      let verifying = false
      const host = litertlmHost()
      const files = detail.files.map((f) => {
        // 1) Provenance: downloaded via TurboLLM. sha256 is the exact-identity key. The
        //    (repo, filename) name fallback is UNCONDITIONAL for every row listed by its
        //    basename — exactly as before .litertlm support — so a re-uploaded quant
        //    (new LFS oid, same name: requant fixes do this a lot) keeps its
        //    "Downloaded"/Load badge, and a split GGUF (never sha-checked: step 2 is gated
        //    on parts === 1) keeps its name match too.
        //    A row listed by FULL PATH is the other case: hf.ts lists same-named bundles
        //    from different subfolders that way ('gpu/model.litertlm' vs
        //    'web/model.litertlm'), and provenance `filename` is always a basename
        //    (downloads.ts records the destination filename), which cannot tell them apart.
        //    But `dest` mirrors the repo's folder layout (<repo>/gpu/model.litertlm), so the
        //    row's own path must be the tail of the recorded dest — that identifies the exact
        //    bundle with or without a hash, and keeps a re-uploaded one (new sha, same path)
        //    Downloaded, while a sibling variant never matches by name alone.
        const listedByPath = f.name !== basename(f.name)
        const pmatch = prov.find((p) => {
          if (p.sha256 && f.sha256 && p.sha256 === f.sha256) return true
          if (p.repo !== repo) return false
          if (!listedByPath) return p.filename === f.name
          return p.filename === basename(f.name) && p.dest.replace(/\\/g, '/').endsWith('/' + f.name)
        })
        let local = pmatch ? models.find((m) => m.path === pmatch.dest) : undefined

        // 2) Content hash: imported / pre-existing files with no provenance. Gated
        //    on exact byte size + single-part to avoid needless hashing and split
        //    ambiguity. Uncached candidates are hashed in the background.
        if (!local && f.sha256 && f.parts === 1) {
          for (const cand of bySize.get(f.sizeBytes) ?? []) {
            const mt = new Date(cand.mtime).getTime()
            const h = d.hashes.get(cand.path, cand.sizeBytes, mt)
            if (h === undefined) {
              d.hashes.ensure(cand.path, cand.sizeBytes, mt)
              verifying = true
            } else if (h === f.sha256) {
              local = cand
              break
            }
          }
        }
        // A .litertlm bundle says whether this device runs it (ADR-462): the web and onboarding read this one answer.
        const runsHere = f.target ? { runsHere: litertlmRunsHere(f.target, host) } : {}
        return { ...f, downloaded: !!local, localKey: local?.key ?? null, ...runsHere }
      })
      // Checkpoint rows (ADR-434 (h)) are annotated the same way, but by sha or destination
      // path: provenance `filename` is a basename, so two checkpoints' identical
      // `model.safetensors` cannot be told apart by name.
      const checkpoints = detail.checkpoints?.map((cp) => ({ ...cp, ...annotateCheckpoint(repo, cp, prov, models) }))
      return c.json({ ...detail, files, ...(checkpoints ? { checkpoints } : {}), verifying })
    } catch (e) {
      return hfErr(c, e)
    }
  })

  // Validate an HF token against whoami-v2 (spec 10 §4). Never 5xx on a bad token.
  app.post('/api/v1/hf/token/test', async (c) => {
    const b = await body<{ token?: string }>(c)
    try {
      return c.json(await d.hf.testToken(b.token ?? ''))
    } catch (e) {
      return hfErr(c, e)
    }
  })

  // ── Downloads (spec 10 §5–6, §8) ──────────────────────────────────────────
  // list/enqueue/remove go through download-lifecycle.ts — the same functions the Turbo
  // Link façade mounts, so the DownloadError → status table has exactly one definition.
  app.get('/api/v1/downloads', (c) => c.json({ downloads: listDownloads(d) }))

  // Enqueue from an HF repo file {repo, rfilename} OR a raw URL {url}. 202.
  app.post('/api/v1/downloads', async (c) => {
    const b = await body<EnqueueInput>(c)
    // A `url` is fetched from any origin the caller names (the host's own LAN, a cloud metadata
    // endpoint) and, with a `subdir`, written under any name the URL ends in, replacing a file
    // already there. So a caller isLocalOrAuthenticated refuses (a keyless Serve identity, Access
    // JWT or open-LAN peer, a remote token) gets no `url`, as the Turbo Link façade's peers get none
    // (link-routes.ts): an HF repo file only, with the `subdir` and `folder` the whole-folder dialog
    // sends alongside it. With `url` out, DownloadManager.enqueue requires a `repo` and `rfilename`,
    // so a `subdir` or `folder` never comes without one. Checked as enqueue does (`if (input.url)`),
    // before anything is queued. api_key_required: the web client opens its key prompt on it.
    if (b?.url && !isLocalOrAuthenticated(c, d))
      return err(c, 403, 'api_key_required', 'Importing a model from a URL requires a valid API key.')
    // One request may fan out into several files (split shards + a shared mmproj) —
    // return every record created so the UI reflects the full queued set. `existing` (additive)
    // is each live row that already held a requested file and so got no second one: a file
    // downloading, queued or paused is answered with its row rather than with nothing, so the
    // caller can follow it, or resume it. Only its id, name and status, which is all that takes:
    // the row is the host's, not one this request created, and the whole of it (the host's
    // path, the URL it came from, its progress) is a read that a remote token with
    // downloads:write but not downloads:read is refused on GET /api/v1/downloads.
    const out = await enqueueDownload(d, b)
    if (!out.ok) return err(c, out.status, out.code, out.message)
    const existing = out.existing.map(({ id, name, status }) => ({ id, name, status }))
    return c.json({ downloads: out.downloads, existing }, 202)
  })

  app.post('/api/v1/downloads/:id/cancel', (c) => {
    const ok = d.downloads.cancel(c.req.param('id'))
    if (!ok) return err(c, 404, 'no_such_download', 'No download with that id.')
    return c.json({ ok: true })
  })

  // Stop a download but keep its partial file, for /resume to continue. Held to what cancel and
  // resume are (requiredCapability maps every /api/v1/downloads write to downloads:write). A row
  // that is neither downloading nor queued answers as resume answers a row it cannot resume.
  app.post('/api/v1/downloads/:id/pause', (c) => {
    if (!d.downloads.pause(c.req.param('id'))) {
      return err(c, 404, 'no_such_download', 'No downloading or queued download with that id.')
    }
    return c.json({ ok: true })
  })

  app.post('/api/v1/downloads/:id/resume', (c) => {
    let ok: boolean
    try {
      ok = d.downloads.resume(c.req.param('id'))
    } catch (e) {
      // The row exists but another one is writing its file: 409, not "no such download".
      const f = toDownloadFailure(e)
      return err(c, f.status, f.code, f.message)
    }
    if (!ok) return err(c, 404, 'no_such_download', 'No paused or errored download with that id.')
    return c.json({ ok: true })
  })

  app.delete('/api/v1/downloads/:id', (c) => {
    const out = removeDownload(d, c.req.param('id'))
    if (!out.ok) return err(c, out.status, out.code, out.message)
    return c.json({ ok: true })
  })
}

/** The /modeldirs response: the configured folders plus the EFFECTIVE primary
 *  (spec 01 §3, ADR-035) — the configured primary when it's still a valid dir,
 *  otherwise the first folder. Empty string when no folders are configured. */
function modelDirsPayload(d: Deps): { dirs: string[]; primaryDir: string } {
  const cfg = d.store.snapshot()
  const primaryDir =
    cfg.primaryModelDir && cfg.modelDirs.includes(cfg.primaryModelDir)
      ? cfg.primaryModelDir
      : (cfg.modelDirs[0] ?? '')
  return { dirs: cfg.modelDirs, primaryDir }
}

/** The engine-adapted search or browse, or, for `category=text-classification` (ADR-444), the category's own search:
 *  it lists what runs on the Laya engine or vLLM whichever engine is active, so it ignores the active engine. */
async function searchHf(d: Deps, q: string, sort: HfSortOption, category: string | undefined): Promise<HfSearchItem[]> {
  if (category === TEXT_CLASSIFICATION_CATEGORY) return d.hf.searchTextClassification(q, sort)
  const engine = d.registry.active()
  // Only what the active engine runs, LiteRT-LM included: a .litertlm model loads only while LiteRT-LM is the active
  // engine (engineForModel), so its repos are searched then and not beside another engine's. An in-app SDK row
  // searches by the formats its own SDK engine reads (ADR-462).
  return q ? d.hf.searchModels(q, engine, sort) : d.hf.browseModels(sort, engine)
}

/** Heuristic count of local quant variants that plausibly belong to an HF repo
 *  (spec 10 §2 `localCount`). Scanned entries carry no HF repo id, so we match the
 *  repo's name segment (after the owner) against the local model name/path,
 *  case-insensitively. Best-effort — drives a "↓ N in library" hint only. */
function localCountFor(d: Deps, repo: string): number {
  const seg = (repo.split('/')[1] ?? repo).toLowerCase().replace(/-gguf$/i, '')
  if (!seg) return 0
  const needle = seg.replace(/[-_.\s]+/g, '')
  let n = 0
  for (const m of d.scanner.list().models) {
    const hay = `${m.name} ${basename(m.path)}`.toLowerCase().replace(/[-_.\s]+/g, '')
    if (hay.includes(needle)) n++
  }
  return n
}

function hfErr(c: Context, e: unknown) {
  if (e instanceof HfError) {
    const status: Status =
      e.code === 'hf_unauthorized' ? 401 : e.code === 'hf_gated' ? 403 : e.code === 'hf_not_found' ? 404 : 503
    return err(c, status, e.code, e.message)
  }
  return err(c, 500, 'internal', (e as Error).message)
}
