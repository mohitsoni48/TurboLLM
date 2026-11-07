import { describe, it, expect } from 'vitest'
import { LOCAL_MCPS } from './mcp-catalog'

// GET /api/v1/settings masks a stdio MCP server's env values (MCP_ENV_MASK) but returns its
// args and command as stored, to every caller allowed to read settings. A secret the catalog
// tells users to type into the Argument field therefore goes out in clear; one typed into an
// env field does not.
const CREDENTIALED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i

describe('LOCAL_MCPS', () => {
  it('MCP Web Engine has no accidental argument or blanket privacy/security claim', () => {
    const engine = LOCAL_MCPS.find((e) => e.id === 'mcp-web-engine')!
    expect(engine.argNote).toBeUndefined()
    expect(engine.desc).toContain('running SearXNG')
    expect(engine.desc).toContain('Markdown')
    expect(engine.desc).not.toMatch(/SSRF-hardened|no query leaves|privacy-first/i)
    if (engine.cmd.includes('git+')) {
      expect(engine.desc).toMatch(/\bgit\b/i)
      expect(engine.cmd).toMatch(/@[0-9a-f]{40}\s+mcp-web-engine$/)
    }
  })

  it('MCP Web Engine explicitly configures search and optional fallback', () => {
    const engine = LOCAL_MCPS.find((e) => e.id === 'mcp-web-engine')!
    const search = engine.envs.find((e) => e.key === 'SEARXNG_URL')!
    expect(search.required).toBe(true)
    expect(search.desc).toContain('http://127.0.0.1:8080/search')
    expect(search.desc).not.toMatch(/default:/i)
    const fallback = engine.envs.find((e) => e.key === 'ALLOW_DDG_FALLBACK')!
    expect(fallback.required).toBe(false)
    expect(fallback.desc).toContain('false')
  })

  it('the PostgreSQL entry takes its password in PGPASSWORD, not in the connection-string argument', () => {
    const pg = LOCAL_MCPS.find((e) => e.id === 'postgres')!
    expect(pg.argNote).toContain('postgresql://user@host/db')
    expect(pg.argNote).not.toMatch(CREDENTIALED_URL)
    expect(pg.envs).toContainEqual(expect.objectContaining({ key: 'PGPASSWORD' }))
  })

  it('no entry asks for a user:password URL as an argument', () => {
    const offenders = LOCAL_MCPS.filter((e) => CREDENTIALED_URL.test(e.argNote ?? '')).map((e) => e.id)
    expect(offenders).toEqual([])
  })
})
