// The JSON body of POST /api/v1/conversations and PATCH /api/v1/conversations/:id, checked before a route stores it.
// Routes used to hand the raw body to SQLite: an object or array in a text field threw a bind error (a bare 500), a
// number was stored as "7.0", an array `sampling` was kept and later spread into the engine request, and a `null`
// body crashed the route. The folder and message routes already answer 400 (nonStringField); this is the same rule.
import { nonStringField } from '../util/string-fields'

const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isSamplingValue = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string' || isStringArray(v)

/** Fields a PATCH may set to null to clear them. Every other field's column is NOT NULL (or has no "cleared" state), so
 *  a null there reads as "absent", exactly as it does on create. */
export const CLEARABLE_ON_PATCH: readonly string[] = ['toolPolicy', 'allowedTools', 'chatAgentId']

/** The body of a PATCH as the store should apply it: only the fields the route reads, with a null for a field that cannot
 *  be cleared dropped. `null.filter`, a NOT NULL constraint failure (500) and `preserveThinking: null` silently writing
 *  false were what a null reached before. */
export function patchFields(b: Record<string, unknown>, clearable: readonly string[] = CLEARABLE_ON_PATCH): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of PATCH_FIELDS) {
    if (b[f] === undefined) continue
    if (b[f] === null && !clearable.includes(f)) continue
    out[f] = b[f]
  }
  return out
}

/** The fields each route reads. PATCH's `toolPolicy`, `allowedTools` and `chatAgentId` take null to clear them. */
export const CREATE_FIELDS = ['title', 'systemPrompt', 'modelKey', 'toolPolicy', 'chatAgentId', 'skillIds', 'allowedTools', 'sampling', 'preserveThinking'] as const
export const PATCH_FIELDS = ['title', 'systemPrompt', 'modelKey', 'toolPolicy', 'chatAgentId', 'skillIds', 'allowedTools', 'sampling', 'preserveThinking'] as const

/** The 400 message for a body the route must refuse, or undefined when every field it reads is well-formed. Absent and
 *  null fields are fine (the route leaves them unset), as they are everywhere else in the API. */
export function conversationBodyError(b: unknown, fields: readonly string[]): string | undefined {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return 'The body must be a JSON object.'
  const body = b as Record<string, unknown>
  const text = nonStringField(body, fields.filter((f) => ['title', 'systemPrompt', 'modelKey', 'toolPolicy', 'chatAgentId'].includes(f)))
  if (text) return `${text} must be a string.`
  for (const f of fields.filter((x) => x === 'skillIds' || x === 'allowedTools')) {
    if (body[f] != null && !isStringArray(body[f])) return `${f} must be an array of strings.`
  }
  const s = fields.includes('sampling') ? body.sampling : undefined
  if (s != null && (typeof s !== 'object' || Array.isArray(s))) return 'sampling must be an object.'
  // Each value is spread into the engine request as a sampler setting: a number, a flag, a name, or the `stop` list.
  const badSampling = s == null ? undefined : Object.entries(s).find(([, v]) => !isSamplingValue(v))
  if (badSampling) return `sampling.${badSampling[0]} must be a number, boolean, string or array of strings.`
  if (fields.includes('preserveThinking') && body.preserveThinking != null && typeof body.preserveThinking !== 'boolean') {
    return 'preserveThinking must be a boolean.'
  }
  return undefined
}
