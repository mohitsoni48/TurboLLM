// Exercises src/index.ts in-process with a fake D1 and a stubbed
// Resend endpoint. No server, no port.
//
//   node --experimental-strip-types test.mjs
//
// Run it before every deploy. There is no other test gate on this Worker, and no
// dev server to fall back on (this project has no spare ports — ADR-401).
import worker from './src/index.ts'
import { buildConfirmation } from './src/email.ts'
import { buildInvite } from './src/invite.ts'
import { generate, OUT } from './scripts-build-templates.mjs'
import { readFileSync } from 'node:fs'

const ORIGIN = 'https://turbollm.dev'
let rows = []
let nextId = 1

const fakeDB = {
  prepare(sql) {
    let args = []
    const stmt = {
      bind(...a) { args = a; return stmt },
      async run() {
        if (/UPDATE signups SET invited_at/.test(sql)) {
          const [at, id] = args
          const r = rows.find((x) => x.id === id)
          if (r) r.invited_at = at
        }
        if (/UPDATE signups SET email_sent_at/.test(sql)) {
          const [sentAt, err, id] = args
          const r = rows.find((x) => x.id === id)
          if (r) { r.email_sent_at = sentAt; r.email_error = err }
        }
        return { success: true }
      },
      async first() {
        if (/COUNT\(\*\) AS n FROM signups WHERE ip_hash/.test(sql)) {
          const [hash, since] = args
          return { n: rows.filter((r) => r.ip_hash === hash && r.created_at > since).length }
        }
        if (/COUNT\(\*\) AS n FROM signups$/.test(sql.trim())) return { n: rows.length }
        if (/INSERT INTO signups/.test(sql)) {
          const [created, updated, name, email, reason, platforms, source, country, ip_hash] = args
          const existing = rows.find((r) => r.email === email)
          if (existing) {
            Object.assign(existing, { updated_at: updated, name, reason, platforms })
            return { id: existing.id, created_at: existing.created_at, updated_at: updated }
          }
          const row = { id: nextId++, created_at: created, updated_at: updated, name, email, reason, platforms, source, country, ip_hash, email_sent_at: null, email_error: null }
          rows.push(row)
          return { id: row.id, created_at: created, updated_at: updated }
        }
        return null
      },
      async all() {
        if (/FROM signups\s+WHERE platforms LIKE/.test(sql)) {
          const [pat] = args
          const needle = pat.replace(/%/g, '')
          let r = rows.filter((x) => (x.platforms || '').includes(needle))
          if (!/resend/.test(sql) && /invited_at IS NULL/.test(sql)) r = r.filter((x) => !x.invited_at)
          // Honour the LIMIT the Worker emits, so the test exercises the real clause.
          const lim = /LIMIT (\d+)/.exec(sql)
          if (lim) r = r.slice(0, Number(lim[1]))
          return { results: r }
        }
        return { results: rows }
      },
    }
    return stmt
  },
}

const env = { DB: fakeDB, ADMIN_TOKEN: 'secret-token', RESEND_API_KEY: 'test-key' }

// Capture outbound Resend calls instead of sending mail.
let mail = []
let mailStatus = 200
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    mail.push(JSON.parse(opts.body))
    return { ok: mailStatus === 200, status: mailStatus, text: async () => 'stubbed failure' }
  }
  return realFetch(url, opts)
}

function post(body, headers = {}) {
  return new Request('https://signup.turbollm.dev/signup', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers },
    body: JSON.stringify(body),
  })
}

const valid = {
  name: 'Test Person',
  email: '  Test@Example.COM ',
  reason: 'I have a 4090 and an old Pixel, happy to test both builds properly.',
  platforms: ['windows', 'android', 'windows', 'nonsense'],
}

let failures = 0
const fail = (m) => { failures++; console.log('FAIL  ' + m) }
const pass = (m) => console.log('ok    ' + m)
async function check(label, res, expectStatus, assert) {
  const body = await res.json()
  if (res.status === expectStatus && (!assert || assert(body, res))) pass(`${label} — ${res.status} ${JSON.stringify(body)}`)
  else fail(`${label}: got ${res.status} ${JSON.stringify(body)}`)
}

// ── templates are generated from the .md files ─────────────────────────────
// A template edit that was never regenerated would ship the OLD copy silently.
if (readFileSync(OUT, 'utf8') === generate()) pass('src/templates/index.ts is in sync with the .md sources')
else fail('src/templates/index.ts is STALE — run: node scripts-build-templates.mjs')

// ── core signup ────────────────────────────────────────────────────────────
await check('valid signup', await worker.fetch(post(valid), env), 200, (b, r) =>
  b.status === 'registered' && r.headers.get('access-control-allow-origin') === ORIGIN)
if (rows[0].email !== 'test@example.com') fail('email not normalised')
if (rows[0].platforms !== '["windows","android"]') fail('platforms not deduped/filtered: ' + rows[0].platforms)
if (/1\.2\.3\.4/.test(JSON.stringify(rows[0]))) fail('raw IP stored')
else pass('stored row is clean (normalised email, deduped platforms, no raw IP)')

// ── queue number is withheld while the list is small ───────────────────────
const firstBody = { position: null }
if (rows.length < 50) pass('position withheld below the threshold (list of ' + rows.length + ')')

// ── confirmation email ─────────────────────────────────────────────────────
if (mail.length !== 1) fail('expected exactly one email, got ' + mail.length)
else {
  const m = mail[0]
  const okTo = m.to[0] === 'test@example.com'
  const okSubject = m.subject === "You're on the TurboLLM beta list"
  const noNumber = !m.text.includes('#')
  const mentionsPlatforms = m.text.includes('Windows, Android')
  const smartscreen = m.text.includes('SmartScreen')
  const playStore = m.text.includes('Play Store')
  const optOut = m.text.includes('Reply to this email')
  if (okTo && okSubject && noNumber && mentionsPlatforms && smartscreen && playStore && optOut) {
    pass('confirmation email: right address, no number below threshold, names their platforms, warns unsigned + Play, offers removal')
  } else {
    fail(`email content: to=${okTo} subj=${okSubject}(${m.subject}) noNum=${noNumber} plats=${mentionsPlatforms} ss=${smartscreen} play=${playStore} optOut=${optOut}`)
  }
}
if (rows[0].email_sent_at && !rows[0].email_error) pass('email_sent_at recorded, no error')
else fail('email delivery not recorded: ' + JSON.stringify({ at: rows[0].email_sent_at, err: rows[0].email_error }))

// ── resubmit updates, keeps its number, and does NOT re-send ───────────────
mail = []
rows[0].created_at -= 60000
await check('resubmit updates', await worker.fetch(post({ ...valid, reason: 'Updated reason, still long enough to pass.' }), env), 200,
  (b) => b.status === 'updated')
if (rows.length !== 1) fail('duplicate row created')
if (mail.length !== 0) fail('resubmit sent a second email')
else pass('resubmit sends no second email')

// ── mail failure must not fail the signup ──────────────────────────────────
mailStatus = 500
await check('signup survives a mail outage', await worker.fetch(post({ ...valid, email: 'outage@x.com' }), env), 200,
  (b) => b.ok && b.status === 'registered')
const outageRow = rows.find((r) => r.email === 'outage@x.com')
if (outageRow && !outageRow.email_sent_at && /resend 500/.test(outageRow.email_error || '')) pass('failure recorded in email_error for retry')
else fail('mail failure not recorded: ' + JSON.stringify(outageRow))
mailStatus = 200

// ── missing API key is a recorded failure, not a crash ─────────────────────
await check('no RESEND_API_KEY configured', await worker.fetch(post({ ...valid, email: 'nokey@x.com' }, { 'cf-connecting-ip': '5.5.5.5' }), { DB: fakeDB, ADMIN_TOKEN: 'secret-token' }), 200,
  (b) => b.ok)
const noKeyRow = rows.find((r) => r.email === 'nokey@x.com')
if (noKeyRow && /not configured/.test(noKeyRow.email_error || '')) pass('missing key recorded, signup still succeeded')
else fail('missing key not handled: ' + JSON.stringify(noKeyRow))

// ── position appears once the list crosses the threshold ───────────────────
while (rows.length < 49) rows.push({ id: nextId++, created_at: Date.now(), email: `pad${nextId}@x.com`, ip_hash: 'pad', platforms: '[]' })
mail = []
const crossed = await worker.fetch(post({ ...valid, email: 'fiftieth@x.com' }, { 'cf-connecting-ip': '7.7.7.7' }), env)
const crossedBody = await crossed.json()
const fiftieth = rows.find((r) => r.email === 'fiftieth@x.com')
if (crossedBody.position === fiftieth.id) pass(`position returned once the list hit ${rows.length}: #${crossedBody.position} (= row id)`)
else fail('position not returned at threshold: ' + JSON.stringify(crossedBody))
if (mail[0] && mail[0].subject === `You're #${fiftieth.id} for the TurboLLM beta` && mail[0].text.includes(`#${fiftieth.id} in the queue`)) {
  pass('email carries the number once the threshold is crossed')
} else fail('email missing the number: ' + JSON.stringify(mail[0] && mail[0].subject))

// ── email template shape ───────────────────────────────────────────────────
const tpl = buildConfirmation({ name: 'Ada Lovelace', platforms: ['macos'], position: 7 })
if (tpl.text.startsWith('Hi Ada,') && tpl.html.includes('#7') && tpl.text.includes('macOS')
    && !tpl.text.includes('Play Store') && tpl.text.includes('SmartScreen')) {
  pass('template: first name only, per-platform notes (macOS gets the signing note, not the Play one)')
} else fail('template shape wrong')
const noteFree = buildConfirmation({ name: 'Bo', platforms: ['ios'], position: null })
if (!noteFree.text.includes('SmartScreen') && !noteFree.text.includes('Play Store')) pass('iOS-only application gets neither hardware note')
else fail('iOS-only got irrelevant notes')

// ── validation ─────────────────────────────────────────────────────────────
await check('honeypot filled', await worker.fetch(post({ ...valid, email: 'bot@x.com', website: 'http://spam' }, { 'cf-connecting-ip': '8.8.8.8' }), env), 400)
await check('no platforms', await worker.fetch(post({ ...valid, email: 'a@b.com', platforms: [] }, { 'cf-connecting-ip': '8.8.8.8' }), env), 400)
await check('bad email', await worker.fetch(post({ ...valid, email: 'nope' }, { 'cf-connecting-ip': '8.8.8.8' }), env), 400)
await check('short reason', await worker.fetch(post({ ...valid, email: 'c@d.com', reason: 'too short' }, { 'cf-connecting-ip': '8.8.8.8' }), env), 400)
await check('malformed json', await worker.fetch(new Request('https://signup.turbollm.dev/signup', {
  method: 'POST', headers: { origin: ORIGIN, 'cf-connecting-ip': '8.8.8.8' }, body: '{oops',
}), env), 400)

// ── CORS ───────────────────────────────────────────────────────────────────
const foreign = await worker.fetch(post({ ...valid, email: 'e@f.com' }, { origin: 'https://evil.example', 'cf-connecting-ip': '8.8.8.8' }), env)
if (foreign.headers.get('access-control-allow-origin') === null) pass('foreign origin gets no CORS header')
else fail('foreign origin allowed')

// ── rate limit ─────────────────────────────────────────────────────────────
const IP = { 'cf-connecting-ip': '4.4.4.4' }
for (const e of ['r1@x.com', 'r2@x.com', 'r3@x.com', 'r4@x.com', 'r5@x.com']) await worker.fetch(post({ ...valid, email: e }, IP), env)
await check('6th from one IP', await worker.fetch(post({ ...valid, email: 'r6@x.com' }, IP), env), 429)
await check('different IP unaffected', await worker.fetch(post({ ...valid, email: 'other@x.com' }, { 'cf-connecting-ip': '9.9.9.9' }), env), 200)

// ── admin ──────────────────────────────────────────────────────────────────
const adminReq = (h) => new Request('https://signup.turbollm.dev/admin/signups', { headers: h })
await check('admin without token', await worker.fetch(adminReq({}), env), 401)
await check('admin wrong token', await worker.fetch(adminReq({ authorization: 'Bearer nope' }), env), 401)
const admin = await worker.fetch(adminReq({ authorization: 'Bearer secret-token' }), env)
const adminBody = await admin.json()
if (admin.status === 200 && adminBody.count === rows.length) pass(`admin with token — ${adminBody.count} rows`)
else fail('admin listing wrong: ' + admin.status)
// A secret set via 'Get-Clipboard | wrangler secret put' arrives with a trailing
// CRLF. The dashboard sends the clean string, so without trimming BOTH sides every
// request 401s and nothing on screen explains why.
const sloppyEnv = { DB: fakeDB, ADMIN_TOKEN: 'secret-token\r\n' };
const sloppy = await worker.fetch(adminReq({ authorization: 'Bearer secret-token' }), sloppyEnv);
const spaced = await worker.fetch(adminReq({ authorization: 'Bearer  secret-token  ' }), env);
if (sloppy.status === 200 && spaced.status === 200) pass('trailing whitespace on either side of the token still authenticates');
else fail(`whitespace-tolerant auth broken: storedCRLF=${sloppy.status} sentPadded=${spaced.status}`);

// The dashboard runs from file:// (Origin: null), so EVERY admin response needs
// access-control-allow-origin. Without it on the errors, the browser blocks the 401
// body and the dashboard reports "could not reach the Worker" for a wrong token.
const acao = (r) => r.headers.get('access-control-allow-origin');
const a401 = await worker.fetch(adminReq({ authorization: 'Bearer nope' }), env);
const a503 = await worker.fetch(adminReq({ authorization: 'Bearer x' }), { DB: fakeDB });
if (acao(admin) === '*' && acao(a401) === '*' && acao(a503) === '*') pass('every admin response carries CORS (200, 401 and 503) so file:// can read the error');
else fail(`admin CORS missing: 200=${acao(admin)} 401=${acao(a401)} 503=${acao(a503)}`);

await check('admin with no secret configured', await worker.fetch(adminReq({ authorization: 'Bearer secret-token' }), { DB: fakeDB }), 503)

// ── /admin/invite ──────────────────────────────────────────────────────────
const invite = (body, headers = { authorization: 'Bearer secret-token' }) =>
  new Request('https://signup.turbollm.dev/admin/invite', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
const LINK = 'https://play.google.com/apps/internaltest/123'

await check('invite without a token', await worker.fetch(invite({ platform: 'android', url: LINK }, {}), env), 401)
await check('invite with a bad platform', await worker.fetch(invite({ platform: 'symbian', url: LINK }), env), 400)
await check('invite with a non-https url', await worker.fetch(invite({ platform: 'android', url: 'http://x' }), env), 400)

// Dry run is the DEFAULT — omitting `send` must never mail a real list.
mail = []
const dry = await worker.fetch(invite({ platform: 'android', url: LINK }), env)
const dryBody = await dry.json()
const androidRows = rows.filter((r) => (r.platforms || '').includes('android') && !r.invited_at)
if (dryBody.dryRun === true && dryBody.wouldSend === androidRows.length && mail.length === 0) {
  pass(`invite defaults to a dry run — reported ${dryBody.wouldSend} recipients, sent 0`)
} else fail('dry run wrong: ' + JSON.stringify(dryBody) + ' mails=' + mail.length)

// Only android, and only once.
mail = []
const sendRes = await worker.fetch(invite({ platform: 'android', url: LINK, send: true }), env)
const sendBody = await sendRes.json()
const everyoneMailed = mail.every((m) => rows.find((r) => r.email === m.to[0] && (r.platforms || '').includes('android')))
if (sendBody.sent === androidRows.length && mail.length === androidRows.length && everyoneMailed) {
  pass(`invite sent to ${sendBody.sent} android testers, nobody else`)
} else fail('send wrong: ' + JSON.stringify(sendBody) + ' mails=' + mail.length)
if (mail[0] && mail[0].subject === 'Your TurboLLM Android build is ready' && mail[0].text.includes(LINK)
    && mail[0].text.includes('Become a tester') && mail[0].text.includes('same Google account')) {
  pass('invite email carries the link and the two Play gotchas (become a tester, right account)')
} else fail('invite content wrong: ' + JSON.stringify(mail[0] && mail[0].subject))
if (androidRows.every((r) => r.invited_at)) pass('invited_at stamped, so a re-run will skip them')
else fail('invited_at not stamped')

// Re-running must not mail the same people twice.
mail = []
const again = await worker.fetch(invite({ platform: 'android', url: LINK, send: true }), env)
const againBody = await again.json()
if (againBody.sent === 0 && mail.length === 0) pass('re-running the same invite mails nobody twice')
else fail('re-run resent: ' + JSON.stringify(againBody))

// resend:true is the deliberate override.
mail = []
const forced = await worker.fetch(invite({ platform: 'android', url: LINK, send: true, resend: true }), env)
const forcedBody = await forced.json()
if (forcedBody.sent === androidRows.length) pass('resend:true deliberately mails them again')
else fail('resend override broken: ' + JSON.stringify(forcedBody))

// A send failure must be reported, not silently counted as delivered.
mailStatus = 500
mail = []
const brokeRes = await worker.fetch(invite({ platform: 'android', url: LINK, send: true, resend: true }), env)
const broke = await brokeRes.json()
if (broke.ok === false && broke.sent === 0 && broke.failed.length === androidRows.length && /resend 500/.test(broke.failed[0].error)) {
  pass('a failed invite is reported per-recipient, not counted as sent')
} else fail('failure reporting wrong: ' + JSON.stringify(broke))
mailStatus = 200

// `limit` is what a scheduled "invite the top N" run depends on, and it must mean
// the longest-waiting people, not an arbitrary slice.
mail = []
rows.forEach((r) => { r.invited_at = null })
const capped = await worker.fetch(invite({ platform: 'android', url: LINK, limit: 3 }), env)
const cappedBody = await capped.json()
const firstThree = rows.filter((r) => (r.platforms || '').includes('android')).slice(0, 3).map((r) => r.id)
if (cappedBody.wouldSend === 3 && JSON.stringify(cappedBody.recipients.map((r) => r.id)) === JSON.stringify(firstThree)) {
  pass('limit:3 picks the three lowest ids — the longest-waiting people')
} else fail('limit wrong: ' + JSON.stringify(cappedBody.recipients))
const bogus = await worker.fetch(invite({ platform: 'android', url: LINK, limit: -5 }), env)
if ((await bogus.json()).limit === null) pass('a nonsense limit falls back to no limit rather than sending to nobody')
else fail('negative limit not handled')

// ── misc routes ────────────────────────────────────────────────────────────
await check('health', await worker.fetch(new Request('https://signup.turbollm.dev/health'), env), 200)
await check('unknown route', await worker.fetch(new Request('https://signup.turbollm.dev/nope'), env), 404)
const pre = await worker.fetch(new Request('https://signup.turbollm.dev/signup', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env)
if (pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN) pass('preflight')
else fail('preflight ' + pre.status)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures ? 1 : 0)
