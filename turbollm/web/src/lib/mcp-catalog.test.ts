import { describe, it, expect } from 'vitest'
import { LOCAL_MCPS } from './mcp-catalog'

// GET /api/v1/settings masks a stdio MCP server's env values (MCP_ENV_MASK) but returns its
// args and command as stored, to every caller allowed to read settings. A secret the catalog
// tells users to type into the Argument field therefore goes out in clear; one typed into an
// env field does not.
const CREDENTIALED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i

describe('LOCAL_MCPS', () => {
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
