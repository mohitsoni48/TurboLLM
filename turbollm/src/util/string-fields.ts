// The text fields of a JSON request body, checked before a route reads them: the routes trim them, hand them to git, the
// shell or the router, or store them as text, and a number, an object, an array or a boolean from an API client threw
// there (`.trim is not a function`, a SQLite bind error), which Hono's default handler answered with a bare 500.

/** The first of `fields` that the request body carries as anything but a string (absent or null is fine). The routes
 *  refuse it with 400 "<field> must be a string." before doing anything. */
export function nonStringField(b: object, fields: readonly string[]): string | undefined {
  return fields.find((f) => {
    const v = (b as Record<string, unknown>)[f]
    return v != null && typeof v !== 'string'
  })
}
