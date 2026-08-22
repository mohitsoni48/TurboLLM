// Turbo Link (ADR-376) capability constants, split out of link-api.ts deliberately:
// link-api.ts is wholesale `vi.mock`'d by TurboLinkSection.test.tsx (per the task
// brief's own literal mock, which only stubs the request functions), so a constant
// defined there would come back `undefined` under that mock. These are plain data, not
// requests, so they belong in their own module the component can import unmocked.
// Mirrors turbollm/src/link/capabilities.ts and turbollm/src/link/types.ts — kept in
// sync by hand, same convention as lib/types.ts.

/** `engines:*` is deliberately ABSENT and must stay absent — ADR-139 settled that no
 *  remote caller gets engine add/scan access, valid key or not. Never render an
 *  engines toggle anywhere in this feature. */
export const LINK_CAPABILITIES = [
  'models:use',
  'models:wake',
  'models:load',
  'models:unload',
  'downloads:read',
  'downloads:write',
  'config:read',
  'config:write',
] as const

export type LinkCapability = (typeof LINK_CAPABILITIES)[number]

/** The three presets offered in the mint UI. "Customize" exposes the raw checkboxes. */
export const LINK_PRESETS: Record<'inference' | 'server' | 'full', LinkCapability[]> = {
  inference: ['models:use'],
  server: ['models:use', 'models:wake', 'models:load', 'models:unload'],
  full: [
    'models:use', 'models:wake', 'models:load', 'models:unload',
    'downloads:read', 'downloads:write', 'config:read', 'config:write',
  ],
}
