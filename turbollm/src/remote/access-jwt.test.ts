import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto'
import { verifyAccessJwt } from './access-jwt'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
// NOTE (Node runtime compat): the plan's snippet wraps this in `createPublicKey(publicKey)`
// before exporting. On the Node version installed here, `createPublicKey` refuses an
// already-public KeyObject ("Invalid key object type public, expected private") — it only
// accepts a private KeyObject (to derive the public half) or raw PEM/DER/JWK. `publicKey` is
// already a public KeyObject, so exporting it directly is equivalent and produces the
// byte-identical JWK; this changes none of the test's assertions or security coverage.
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', alg: 'RS256' }
const JWKS = { keys: [jwk] }

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

function makeJwt(claims: Record<string, unknown>, kid = 'k1'): string {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid })
  const body = b64(claims)
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')
  return `${head}.${body}.${sig}`
}

const TEAM = 'https://acme.cloudflareaccess.com'
const AUD = 'aud-123'
const now = () => Math.floor(Date.now() / 1000)
const good = () => ({ iss: TEAM, aud: [AUD], exp: now() + 600, iat: now() - 10, sub: randomUUID(), email: 'sam@example.com' })
const opts = { teamDomain: TEAM, aud: AUD, jwks: JWKS }

test('access-jwt: a valid assertion verifies', async () => {
  const r = await verifyAccessJwt(makeJwt(good()), opts)
  assert.equal(r.ok, true)
})

test('access-jwt: a wrong audience is refused', async () => {
  const r = await verifyAccessJwt(makeJwt({ ...good(), aud: ['someone-else'] }), opts)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason.includes('audience'), true)
})

test('access-jwt: a wrong issuer is refused', async () => {
  const r = await verifyAccessJwt(makeJwt({ ...good(), iss: 'https://evil.cloudflareaccess.com' }), opts)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason.includes('issuer'), true)
})

test('access-jwt: an expired assertion is refused', async () => {
  const r = await verifyAccessJwt(makeJwt({ ...good(), exp: now() - 60 }), opts)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason.includes('expired'), true)
})

test('access-jwt: a tampered payload fails the signature check', async () => {
  const jwt = makeJwt(good())
  const [h, , s] = jwt.split('.')
  const forged = `${h}.${b64({ ...good(), email: 'attacker@example.com' })}.${s}`
  const r = await verifyAccessJwt(forged, opts)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason.includes('signature'), true)
})

test('access-jwt: an unknown kid is refused rather than tried against every key', async () => {
  const r = await verifyAccessJwt(makeJwt(good(), 'other-kid'), opts)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason.includes('key'), true)
})

test('access-jwt: malformed input is refused without throwing', async () => {
  assert.equal((await verifyAccessJwt('not.a.jwt', opts)).ok, false)
  assert.equal((await verifyAccessJwt('', opts)).ok, false)
})

test('access-jwt: an alg the header claims but we do not support is refused (no alg confusion)', async () => {
  const head = b64({ alg: 'none', typ: 'JWT', kid: 'k1' })
  const body = b64(good())
  assert.equal((await verifyAccessJwt(`${head}.${body}.`, opts)).ok, false)
})
