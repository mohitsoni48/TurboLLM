import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'
import { linkAuth, requireCapability } from './link-auth'
import { gatewayV1Handler } from '../gateway/gateway'
import { buildModelStatus } from '../api/status-view'
import { startEngine, stopEngine } from '../api/engine-lifecycle'
import {
  enqueueDownload,
  listDownloads,
  removeDownload,
  type DownloadFailure,
} from '../api/download-lifecycle'
import { allowsModel, hasCapability } from './capabilities'
import { canWake, hostIdleState } from './host-idle'
import { FALLBACK_MACHINE_NAME, sanitizeMachineName } from './machine-name'
import { LINK_API_VERSIONS } from './protocol'
import { LINK_CAPABILITIES, redactDownload, type HelloResponse } from './types'
import { emit } from '../telemetry/runtime/typed-emit'
import { inferenceServed } from '../telemetry/events/link'

// linkAuth (link-auth.ts) puts the resolved key on the context as `linkKey`, but the
// plain `Hono` type in this function's signature carries no Variables — so route
// handlers below see it through this narrowed local alias rather than widening the
// exported signature (which task 6's interface pins to `Hono`).
type LinkEnv = { Variables: { linkKey: ApiKey } }

/** Stable identity for THIS install, minted once and persisted. The peer keeps it so it
 *  can tell "the tunnel URL changed but it's the same box" (normal, every Kaggle session)
 *  from "this URL now points at a DIFFERENT box" (needs a warning, not a silent adopt). */
export function machineId(d: Deps): string {
  const daemon = d.store.snapshot().daemon as { machineId?: string }
  if (daemon.machineId) return daemon.machineId
  const id = randomUUID()
  d.store.update((cfg) => {
    ;(cfg.daemon as unknown as { machineId?: string }).machineId ??= id
  })
  return id
}

/** What this box calls itself to a peer.
 *
 *  `daemon.machineName` is the user's own choice (Settings → Turbo Link). When it is unset
 *  — which it is on every existing install, since nothing wrote the field before this —
 *  fall back to the OS HOSTNAME rather than the literal string "TurboLLM": every host
 *  answering with an identical constant makes the peer's "Linked machines" list, and
 *  `describeStatus`'s deliberately machine-naming copy, useless the moment there are two
 *  links. `os.hostname()` is cross-platform and needs no configuration; the constant
 *  survives only as a last resort for the (theoretical) empty-hostname case. */
export function resolveMachineName(configured: string | undefined): string {
  // Sanitised at the source, not just on adoption. A peer that trusts this field turns it
  // into the machine segment of every qualified `<machine>/<model>` id, and `/` there
  // sends the id into the peer's LOCAL substring resolution (machine-name.ts). A hostname
  // cannot contain `/`, but `daemon.machineName` is a free-text field — and a peer running
  // an older build has no sanitiser of its own, so the honest fix is to never emit one.
  const chosen = configured?.trim()
  if (chosen) return sanitizeMachineName(chosen)
  try {
    return sanitizeMachineName(hostname())
  } catch {
    return FALLBACK_MACHINE_NAME
  }
}

/** Single-attribution reporting for a federated generation (spec §5.6).
 *
 *  THIS machine is the host — it ran the tokens, so it is the one that counts them. The
 *  peer that took the click and proxied the request here reports nothing for the same
 *  generation (see the remote branch in gateway/gateway.ts): counting on both ends would
 *  double every federated generation and corrupt every funnel derived from it.
 *
 *  Three properties, all deliberate:
 *   - **Absent telemetry is a no-op.** `d.telemetry` is optional (absent in tests, and
 *     whenever the emitter failed to construct) — same convention as link-admin-routes.ts.
 *   - **A throw can never reach the caller.** This runs on the generation path; attribution
 *     must never be the reason a prompt fails. `Emitter.emit` swallows its own errors
 *     today, so the catch is belt-and-braces against a future one that doesn't.
 *   - **Only a REAL generation is counted.** Callers invoke this only after the shared
 *     gateway handler answered; a capability refusal or a typed wake-gate 503 returns
 *     earlier and is never reported, because the host ran nothing.
 *
 *  `cancelled` (core/enums.ts's `OUTCOMES`) is deliberately never emitted here: a client
 *  that vanishes mid-stream is not observable at this point without instrumenting the SSE
 *  relay itself, and a guessed value is worse than an absent one. */
function reportServed(d: Deps, outcome: 'ok' | 'fail', streamed: boolean): void {
  if (!d.telemetry) return
  try {
    emit(d.telemetry, inferenceServed, { via: 'link', outcome, streamed })
  } catch { /* never break a generation over a telemetry write */ }
}

/** A Hugging Face repo id: exactly `owner/name`, both segments drawn from the character
 *  set HF actually permits. Anchored and single-slash on purpose — `a/b/c`, `../../etc`
 *  and a bare name are all malformed, and each of them would otherwise reach code that
 *  builds a destination directory out of the string. */
const HF_REPO_ID = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/

/** A file WITHIN that repo: a `.gguf`, with no traversal and no absolute-path shape.
 *  Forward slashes are allowed (HF repos have subfolders) — `\` is not, since it is a
 *  separator on the host even though it is a legal filename character on HF. */
function isSafeRepoFile(rfilename: string): boolean {
  if (!rfilename || rfilename.length > 512) return false
  if (!/\.gguf$/i.test(rfilename)) return false
  if (rfilename.includes('\\') || rfilename.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(rfilename)) return false
  return rfilename.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** Serialize a `DownloadFailure` for a PEER.
 *
 *  The one difference from the local route's rendering, and the reason this exists: a
 *  `hostDetail` message is a raw `Error.message` from the host's filesystem or network
 *  stack, which routinely carries an absolute path. The local UI shows it (same machine);
 *  a peer gets the code and a fixed string. The failure is still visible and still typed —
 *  only the host's free text is withheld. */
function linkDownloadErr(c: { json: (b: unknown, s: number) => Response }, f: DownloadFailure): Response {
  return c.json(
    {
      error: {
        code: f.code,
        message: f.hostDetail ? 'The host could not start that download.' : f.message,
      },
    },
    f.status,
  )
}

/** Mount ONLY the façade's gate. Split out from `registerLinkApi` so `createApp` can put
 *  the gate before the feature-telemetry middleware and the handlers after it: telemetry
 *  must not count a request that was rejected, and a handler registered BEFORE the
 *  telemetry middleware short-circuits it entirely (Hono composes in registration order),
 *  which is why the `link` feature previously only ever recorded 404s. Callers that do not
 *  care about that ordering — every test, and any future embedder — get both from
 *  `registerLinkApi` in one call, unchanged. */
export function registerLinkAuth(app: Hono, d: Deps): void {
  ;(app as unknown as Hono<LinkEnv>).use('/api/link/v1/*', linkAuth(d))
}

/** Mount the Turbo Link façade (ADR-376).
 *
 *  Deliberately NARROW and explicitly versioned: this is the contract two
 *  independently-updated TurboLLM installs agree on. Routes added here mount EXISTING
 *  handlers behind requireCapability — never reimplement a handler, or the façade
 *  becomes a fork that drifts from the internal API it mirrors.
 *
 *  Register AFTER lanAuth in server.ts. linkAuth then exempts nothing (spec §3.3). */
export function registerLinkApi(app: Hono, d: Deps, opts?: { authAlreadyRegistered?: boolean }): void {
  const linkApp = app as unknown as Hono<LinkEnv>
  if (!opts?.authAlreadyRegistered) registerLinkAuth(app, d)

  linkApp.post('/api/link/v1/hello', (c) => {
    const key = c.get('linkKey')
    // A legacy key (no grant) is full-access, so it must report EVERY capability —
    // reporting [] would grey out every control on the peer for an otherwise valid key.
    const capabilities = key.grant ? key.grant.capabilities : [...LINK_CAPABILITIES]
    const models = key.grant?.models?.length ? key.grant.models : undefined
    const daemon = d.store.snapshot().daemon as { machineName?: string }
    const body: HelloResponse = {
      machineId: machineId(d),
      machineName: resolveMachineName(daemon.machineName),
      appVersion: d.version,
      linkApiVersions: [...LINK_API_VERSIONS],
      capabilities,
      ...(models ? { models } : {}),
    }
    return c.json(body)
  })

  linkApp.get('/api/link/v1/models', requireCapability('models:use'), (c) => {
    const key = c.get('linkKey')
    const loadedKey = d.manager.status().model?.key ?? null
    const models = d.scanner.list().models
      .filter((e) => allowsModel(key, e.key))
      .map((e) => ({
        key: e.key,
        name: e.name,
        quant: e.quant ?? null,
        nativeCtx: e.nativeCtx ?? null,
        vision: Boolean(e.vision),
        loaded: e.key === loadedKey,
      }))
    // Deliberately does NOT include `path`. A peer has no business knowing the host's
    // filesystem layout, and it is the kind of field that leaks by accident when a
    // handler spreads the whole entry.
    const daemon = d.store.snapshot().daemon as { machineName?: string }
    return c.json({ machineName: resolveMachineName(daemon.machineName), models })
  })

  /** Stats parity (spec §5.4). The host re-exports its EXISTING status shape; the peer
   *  renders it with the components it already uses for its own engine card. There is no
   *  remote-stats model and no translation layer — both this route and the local
   *  `/api/v1/status` are fed by `buildModelStatus`, which is the only thing that keeps
   *  them from drifting.
   *
   *  Gated on `models:use` rather than being open to any valid key: live t/s, TTFT and
   *  context use describe what the machine's owner is doing right now, and a link that may
   *  not use the models has no business watching them.
   *
   *  `engine.launchCommand` — the engine's absolute binary + model paths — is NOT part of
   *  the shared builder, so it cannot cross here. See status-view.ts. */
  linkApp.get('/api/link/v1/status', requireCapability('models:use'), (c) =>
    c.json(buildModelStatus(d)),
  )

  /** Remote model load (spec §5.3). Mounts the EXISTING `startEngine` — the same function
   *  `POST /api/v1/engine/start` calls — behind `requireCapability`, so eviction, the keep-N
   *  pool, the ComfyUI guard, the auto-tune kill switch and swap serialization are literally
   *  the same code for a peer as for the local UI. Nothing here re-implements a load, and
   *  nothing here adds a second lock: `startEngine` already goes through
   *  `modelRouter.withSwapLock`, so a second remote load queues behind an in-flight one.
   *
   *  Three checks run BEFORE delegating, and all three are façade concerns the local route
   *  has no business carrying:
   *   1. `modelKey` is REQUIRED. `startEngine` treats an empty request as "re-load
   *      `lastLoaded`" (the Engines "Start" button) — a peer must never trigger that by
   *      omission, because the model it would load is one the grant may not even allow.
   *   2. The grant allowlist, exact-match (`allowsModel`) — the same predicate
   *      `GET /api/link/v1/models` filters with, so a peer can only load what it can see.
   *   3. An unknown key is a clean 404. `startEngine` would otherwise fall through to its
   *      transitional path/devModel branch and answer 409 `no_such_model` — a confusing
   *      code for "you named a model I don't have", and one whose branch a remote caller
   *      must never reach at all (it launches a caller-named FILESYSTEM PATH; ADR-139).
   *      Passing `{ modelKey }` alone — never the peer's raw body — is what forecloses it.
   *
   *  The body it returns is `startEngine`'s own `{ ok: true }` / typed error, which carries
   *  no filesystem detail (see engine-lifecycle.ts). */
  linkApp.post('/api/link/v1/models/load', requireCapability('models:load'), async (c) => {
    const key = c.get('linkKey')
    const body = await c.req.json().catch(() => ({})) as { modelKey?: unknown }
    const modelKey = typeof body.modelKey === 'string' ? body.modelKey.trim() : ''
    if (!modelKey) {
      return c.json({ error: { code: 'invalid_input', message: 'modelKey is required.' } }, 400)
    }
    if (!allowsModel(key, modelKey)) {
      return c.json({ error: { code: 'forbidden', message: `This link may not use '${modelKey}'.` } }, 403)
    }
    if (!d.scanner.get(modelKey)) {
      return c.json({ error: { code: 'no_such_model', message: `No model '${modelKey}' on this machine.` } }, 404)
    }
    return startEngine(c, d, { modelKey })
  })

  /** Remote unload (spec §5.3) — the SAME `stopEngine` `POST /api/v1/engine/stop` calls.
   *
   *  Gated on `models:unload`, which `models:load` deliberately does NOT imply: a token
   *  granted "you may put a model up" was not granted "you may take the host's model down"
   *  while its owner is mid-conversation. They are separate boxes in the mint UI and
   *  separate gates here; capabilities.test.ts pins that they stay distinct. */
  linkApp.post('/api/link/v1/models/unload', requireCapability('models:unload'), (c) =>
    stopEngine(c, d),
  )

  /** Remote downloads (spec §5.7). All three mount `download-lifecycle.ts` — the SAME
   *  functions `/api/v1/downloads` uses — so the queue, the concurrency cap, the disk
   *  check, the split-shard expansion and the DownloadError → status table are literally
   *  one implementation for a peer and for the local UI.
   *
   *  `downloads:read` and `downloads:write` are separate gates and neither implies the
   *  other: watching what a machine is pulling and making it pull something are different
   *  grants. A read without the capability is a NAMED 403, never an empty list — an empty
   *  200 reads as "the host has no downloads" and sends the user debugging the wrong box. */
  linkApp.get('/api/link/v1/downloads', requireCapability('downloads:read'), (c) =>
    c.json({ downloads: listDownloads(d).map(redactDownload) }),
  )

  /** Start a download on the host.
   *
   *  The peer's raw body is NEVER forwarded — the same rule as `models/load` (ADR-139).
   *  Exactly two peer-chosen fields describe WHAT to fetch, and both are validated here:
   *   - `repo` must be a well-formed `owner/name` HF id. `DownloadManager.enqueue` would
   *     also reject a malformed one, but only after resolving a destination directory, and
   *     validating at the boundary is what makes a garbage id a clean 400 instead of a
   *     fault deeper in.
   *   - `rfilename` must be a `.gguf` with no path traversal in it.
   *
   *  Three fields of `EnqueueInput` are deliberately DROPPED rather than passed through:
   *   - `subdir` is `join()`ed onto the host's model dir unsanitised — a peer-supplied
   *     `..` there writes outside it.
   *   - `url` makes the host fetch an arbitrary origin (its own LAN, a cloud metadata
   *     endpoint) and, with `subdir`, to an arbitrary filename.
   *   - `excludeMmproj` is onboarding's internal flag, not part of this contract.
   *  `size` and `sha256` ARE accepted: they only ever tighten behaviour (the free-disk
   *  check and the checksum verification). */
  linkApp.post('/api/link/v1/downloads', requireCapability('downloads:write'), async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
    const rfilename = typeof body.rfilename === 'string' ? body.rfilename.trim() : ''
    if (!HF_REPO_ID.test(repo) || !isSafeRepoFile(rfilename)) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: "repo must be a Hugging Face 'owner/name' id and rfilename a .gguf file in it.",
          },
        },
        400,
      )
    }
    const out = await enqueueDownload(d, {
      repo,
      rfilename,
      ...(typeof body.size === 'number' && Number.isFinite(body.size) && body.size >= 0
        ? { size: body.size }
        : {}),
      ...(typeof body.sha256 === 'string' ? { sha256: body.sha256 } : {}),
    })
    if (!out.ok) return linkDownloadErr(c, out)
    return c.json({ downloads: out.downloads.map(redactDownload) }, 202)
  })

  /** Cancel a download and forget it: `removeDownload` aborts the in-flight stream and
   *  deletes the `.part`.
   *
   *  Works on ANY download, including one the host's own user started. Downloads are
   *  host-owned; there is no per-link ownership model, and inventing one would mean a peer
   *  could see a stuck download in the list it is granted to read and be unable to stop it. */
  linkApp.delete('/api/link/v1/downloads/:id', requireCapability('downloads:write'), (c) => {
    const out = removeDownload(d, c.req.param('id'))
    if (!out.ok) return linkDownloadErr(c, out)
    return c.json({ ok: true })
  })

  linkApp.post('/api/link/v1/chat/completions', requireCapability('models:use'), async (c) => {
    const key = c.get('linkKey')
    const body = await c.req.json().catch(() => ({})) as { model?: string; stream?: unknown }
    const requested = body.model ?? ''
    if (requested && !allowsModel(key, requested)) {
      return c.json({ error: { code: 'forbidden', message: `This link may not use '${requested}'.` } }, 403)
    }

    // Wake gating (spec §5.5). The idle judgement lives HERE because only the host can
    // make it. A peer with models:use but not models:wake may use what is already up;
    // anything else is a TYPED 503 the peer renders as "in use locally", never a
    // generic error the user cannot act on.
    //
    // The loaded/cold comparison is an EXACT key match, deliberately, even though
    // ModelRouter.resolveEntry matches fuzzily downstream: `loaded` is precisely the flag
    // GET /api/link/v1/models already reported to this peer, so the gate answers the
    // question the peer actually asked. A fuzzier test here would let a near-miss id slip
    // past the gate and reach the swap machinery anyway.
    const loaded = d.manager.status().model?.key ?? null
    if (requested && requested !== loaded) {
      if (hasCapability(key, 'models:load')) {
        // Unconditional by design: models:load IS the "you may take the machine" grant.
        // Fall through to the normal auto-swap path.
      } else if (hasCapability(key, 'models:wake')) {
        if (!canWake(hostIdleState(d))) {
          return c.json(
            { error: { code: 'host_busy', message: 'The host is in use locally. Try again shortly.' } },
            503,
          )
        }
      } else {
        return c.json(
          {
            error: {
              code: 'model_not_loaded',
              message: `'${requested}' is not loaded on this machine, and this link may not load it.`,
            },
          },
          503,
        )
      }
    }

    // The SAME function the public /v1/chat/completions mount calls — never a
    // reimplementation. `pathname` is what makes the peer's /api/link/v1 URL behave as
    // the /v1 route it proxies; `origin: 'link'` keeps this out of the local-activity
    // ledger the wake gate above reads.
    const res = await gatewayV1Handler(c, d, { pathname: '/v1/chat/completions', origin: 'link' })
    // Reported HERE and nowhere else: every early return above is a refusal, not a
    // generation. See reportServed's own comment for why the peer stays silent.
    reportServed(d, res.status < 400 ? 'ok' : 'fail', body.stream === true)
    return res
  })
}
