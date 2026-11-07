// The small HTTP helpers every /api/v1 route module shares.
import type { Context } from 'hono'
import { ValueError } from '../config/config'
import { NotFoundError } from '../engines/registry'

export type Status = 200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 501 | 502 | 503

export function err(c: Context, status: Status, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

/** The request's JSON body as sent, any JSON type; {} when it does not parse. */
export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

/** The request's JSON body as the route's object of fields: {} when it does not parse or is not an object. A JSON
 *  `null` used to reach the handlers, and the first field read threw (startEngine's `b.modelKey`, the MCP server's
 *  `b.transport`, a key's `b.name`): the caller got Hono's bare text/plain 500 instead of the route's own 400 or 409.
 *  For a route that reads only fields of the body, an array or a primitive read as {} already (each field undefined).
 *  A route that refuses a body that is not an object reads jsonBody instead (PATCH /settings, the profile PUT). */
export async function body<T>(c: Context): Promise<T> {
  const b = await jsonBody(c)
  return (typeof b === 'object' && b !== null && !Array.isArray(b) ? b : {}) as T
}

export function regErr(c: Context, e: unknown) {
  if (e instanceof NotFoundError) return err(c, 404, 'engine_not_found', 'No engine with that id.')
  if (e instanceof ValueError) return err(c, 400, 'invalid_config_value', e.message)
  return err(c, 500, 'internal', (e as Error).message)
}
