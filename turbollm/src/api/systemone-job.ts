// The text classification playground's run as a daemon job (ADR-439). The playground used to post /v1/systemone itself,
// a gateway route that lives as long as its client (clientAbort): closing, reloading or leaving the screen mid-run
// threw the run away, and a finished answer existed only in that response, so a reload lost it too. The daemon is the
// server and the page only a frontend, so the page now starts a job here and follows it; going away only stops the
// watching. /v1/systemone keeps its own lifetime for API clients, and the curl the playground shows still names it.
//
// The shape is the release install's (ReleaseInstallJob, engines/release-install.ts), the closest pattern: one slot the
// page polls with GET, a DELETE that cancels, an outcome that a cancelled run can no longer overwrite. One job at a
// time, and a second POST while it runs is refused (409) rather than cancelling it: the other run belongs to another
// tab or device, whose answer only its own Cancel may throw away. A run is one System One request of bounded size (at
// most four /classify calls, after a model load when auto-swap loads one), and a page refused with 409 follows that
// run and can Cancel it, so nothing is stuck for long. The last outcome is kept in memory only; a daemon restart
// forgets it.
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { holdTurn } from '../auth'
import type { Deps } from '../deps'
import { jevErrorResponse, jsonBodyOf, refusalFor } from '../gateway/jev-serving'
import { answerSystemOne, unprocessable, type SystemOneAnswer } from '../gateway/systemone-endpoint'
import type { SystemOneInput } from '../models/systemone'
import { parseSystemOneBody } from '../models/systemone-request'

/** The one path of the job's routes (POST starts, GET reads, DELETE cancels). auth.ts's requiredCapability maps it to
 *  `models:use`, as /v1/* and the chat routes are: whoever may ask may read the answer, and no one else. */
export const SYSTEMONE_JOB_PATH = '/api/v1/jev/playground/run'

/** GET's answer: `idle` before any run. `request` is the body the run answers (what the curl shows); `response`
 *  is /v1/systemone's own answer once `done`; `error` its refusal (code and message as /v1/systemone answers them)
 *  once `error`. An engine stopped or unloaded mid-run ends it as `error`, as it ends a /v1/systemone request: the
 *  engine call fails. */
export interface SystemOneJobView {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  id?: string
  request?: SystemOneInput
  response?: SystemOneAnswer
  error?: { code: string; message: string }
  startedAt?: string
  finishedAt?: string
}

/** The single slot. It only remembers; the route owns what a run does. */
export class SystemOneJob {
  private view: SystemOneJobView = { state: 'idle' }
  private abort: AbortController | null = null

  get(): SystemOneJobView {
    return this.view
  }

  /** Starts `run` with the job's own abort signal and answers the running view, or null while another run is still
   *  running. The run outlives the request that started it: nothing but cancel() aborts its signal. */
  start(request: SystemOneInput, run: (signal: AbortSignal) => Promise<SystemOneAnswer>): SystemOneJobView | null {
    if (this.view.state === 'running') return null
    const id = randomUUID()
    const ac = new AbortController()
    this.abort = ac
    this.view = { state: 'running', id, request, startedAt: new Date().toISOString() }
    // A cancelled run's late outcome is dropped: cancel() has already settled the view.
    const settle = (outcome: Pick<SystemOneJobView, 'state' | 'response' | 'error'>) => {
      if (this.view.id !== id || this.view.state !== 'running') return
      this.abort = null
      this.view = { ...this.view, ...outcome, finishedAt: new Date().toISOString() }
    }
    run(ac.signal).then(
      (response) => settle({ state: 'done', response }),
      (error: unknown) => settle(ac.signal.aborted ? { state: 'cancelled' } : { state: 'error', error: failureOf(error) }),
    )
    return this.view
  }

  /** Cancel the running run, if `id` names it (a page's Cancel names the run it follows, so a late click never stops
   *  a newer run); without `id`, whatever runs. True when a run was cancelled. */
  cancel(id?: string): boolean {
    if (this.view.state !== 'running' || (id !== undefined && id !== this.view.id)) return false
    this.abort?.abort()
    this.abort = null
    this.view = { ...this.view, state: 'cancelled', finishedAt: new Date().toISOString() }
    return true
  }
}

/** /v1/systemone's refusal for the same failure; anything else (a bug) by its message. */
function failureOf(error: unknown): { code: string; message: string } {
  try {
    const { code, message } = refusalFor(error)
    return { code, message }
  } catch {
    return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
  }
}

const RUN_IN_PROGRESS = 'A text classification run is already in progress. Wait for it, or cancel it first.'

/** POST validates the body exactly as /v1/systemone does (its 422, and nothing started) and answers 202 with the
 *  running view at once; 409 `run_in_progress`, carrying the running view as `run`, while one runs. GET answers the
 *  view. DELETE cancels the running run (`?id=` names it) and answers the view. `fetchImpl` is the engine call's,
 *  for tests; the global fetch otherwise, read at call time. */
export function registerSystemOneJobRoutes(app: Hono, d: Deps, fetchImpl?: typeof fetch): void {
  const job = new SystemOneJob()
  app.post(SYSTEMONE_JOB_PATH, async (c) => {
    const parsed = parseSystemOneBody(await jsonBodyOf(c))
    if (!parsed.ok) return jevErrorResponse(c, unprocessable(parsed.problem))
    const { input } = parsed
    let release = () => {}
    // The run settles a microtask after start() at the earliest, so `release` is the held run's by then.
    const started = job.start(input, (signal) => answerSystemOne(d, input, signal, fetchImpl ?? fetch).finally(() => release()))
    if (!started) return c.json({ error: { code: 'run_in_progress', message: RUN_IN_PROGRESS }, run: job.get() }, 409)
    // The run outlives this request, so it is held as a chat turn is (holdTurn): revoking the key it was started with,
    // requiring a key of the keyless open-LAN peer that started it, turning LAN access off (for a LAN peer's run) or
    // stopping remote access (for one that came through it) cancels it. While it ran in a /v1/systemone request it
    // ended with that request's connection; as a job it ran on after its caller's access was gone. The host's runs
    // are not held: nothing of those stops them.
    const id = started.id!
    release = holdTurn(c, d, () => { job.cancel(id) })
    return c.json(started, 202)
  })
  app.get(SYSTEMONE_JOB_PATH, (c) => c.json(job.get()))
  app.delete(SYSTEMONE_JOB_PATH, (c) => {
    job.cancel(c.req.query('id') || undefined)
    return c.json(job.get())
  })
}
