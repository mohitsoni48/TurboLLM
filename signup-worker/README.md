# signup-worker — beta-tester applications (ADR-401)

Backs the form at [turbollm.dev/beta](https://turbollm.dev/beta). A separate Worker and a separate
D1 database from `telemetry-worker/` on purpose: telemetry's design promise is that it holds nothing
that identifies a person, and this form holds a name and an email address. Different database, so
that claim stays literally true.

| | |
|---|---|
| Public endpoint | `POST https://signup.turbollm.dev/signup` |
| Admin endpoint | `GET https://signup.turbollm.dev/admin/signups` (bearer token) |
| Dashboard | `dashboard.html` — open from disk, never deployed |
| Page | `docs/site-build/pages/beta.html` → `/beta` |

## First deploy

Nothing here is provisioned yet — these four steps create the database, apply the schema, set the
admin secret and ship the Worker.

```powershell
cd D:\llama-turbo\signup-worker
npx wrangler d1 create turbollm-signup
```

Paste the `database_id` it prints into `wrangler.toml`, then:

```powershell
npx wrangler d1 execute turbollm-signup --remote --file=schema.sql
npx wrangler deploy
```

Then set the two secrets — **follow "Setting the secrets" below rather than improvising**, because
the obvious ways to do it fail quietly and one of them leaks the value. `ADMIN_TOKEN` is the only
thing standing between the public internet and the applicant list.

(Note for anyone reaching for a one-liner: `[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)`
is .NET Core only and throws on Windows PowerShell 5.1. Use the `::Create()` form in the next
section, which works on both.)

The deploy provisions `signup.turbollm.dev` as a custom domain (a proxied DNS record is created as
part of the deploy, so "deployed" and "reachable" are the same statement). Verify:

```powershell
curl.exe https://signup.turbollm.dev/health
```

## Setting the secrets — use a file, not the clipboard

Both secrets cost a real debugging session to set correctly. Two traps, in order of how
much time they burn:

1. **`wrangler secret put X` takes the secret's NAME as its argument, and asks for the
   value separately.** Passing the value creates a secret *named* after your token. Secret
   names are not secret — `wrangler secret list` and the Cloudflare dashboard both print
   them in plain text — so a key fed in this way must be treated as leaked and rotated.
2. **`Get-Clipboard | wrangler secret put …` pipes a trailing CRLF**, and the clipboard can
   change between generating a value and setting it. Either way the stored secret differs
   from what you paste elsewhere, and every request 401s with nothing on screen explaining
   why. (The Worker now trims both sides, so the newline alone no longer breaks it — but a
   stale clipboard still will.)

Use a file as the single source for both the secret and your test, so there is nothing to
get out of sync (PowerShell):

```powershell
# 1. generate to a file — -NoNewline matters
$b = New-Object byte[] 32
([Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($b)
(($b | ForEach-Object { $_.ToString('x2') }) -join '') | Set-Content -NoNewline "$env:TEMP\tok.txt"

# 2. set it from that exact file
Get-Content -Raw "$env:TEMP\tok.txt" | npx wrangler secret put ADMIN_TOKEN --name turbollm-signup

# 3. prove it works, bypassing the dashboard entirely
$t = (Get-Content -Raw "$env:TEMP\tok.txt").Trim()
curl.exe -s -H "Authorization: Bearer $t" https://signup.turbollm.dev/admin/signups

# 4. paste the file's contents into the dashboard, then delete it
Remove-Item "$env:TEMP\tok.txt"
```

`{"ok":true,"count":0,...}` from step 3 means the token is right and any remaining problem
is in the dashboard field. Confirm what is actually set with `npx wrangler secret list
--name turbollm-signup` — you want exactly two entries named `ADMIN_TOKEN` and
`RESEND_API_KEY`. A long random string appearing as a *name* means trap 1 happened.

## Confirmation email (Resend)

Every first-time applicant gets one email: their queue number, the platforms they picked, and what
happens next. Resubmitting to fix a typo does **not** send a second one.

Before `RESEND_API_KEY` is worth setting, verify the sending domain once in Resend:

1. Sign in at [resend.com](https://resend.com) → **Domains** → add `turbollm.dev`.
2. It gives you three DNS records (DKIM, SPF, and a return-path CNAME). Add them in the Cloudflare
   dashboard for `turbollm.dev` — DNS-only, not proxied.
3. Wait for Resend to show the domain as Verified, then **API Keys** → create one with send
   permission and paste it into `wrangler secret put RESEND_API_KEY`.

The Worker sends from `beta@turbollm.dev` with a reply-to of `human@turbollm.dev` (both in
`src/email.ts`) — the from-address only needs the domain verified, not the mailbox to exist, but
replies do need to land somewhere, which is what the reply-to is for.

**A mail outage can never fail a signup.** The row is written and the response returned first; the
send happens afterwards in `ctx.waitUntil`, and its outcome is recorded in `email_sent_at` /
`email_error`. The dashboard shows an "Email unsent" count and marks those rows, so failures are
visible and can be chased rather than silently lost.

### The queue number

The number is the row id, so it never shifts and never needs recalculating. Two rules worth knowing
before someone asks:

- **It is withheld until the list reaches 50 signups** (`SHOW_POSITION_FROM` in `src/index.ts`).
  "You're #3" advertises an empty list. Below the threshold the email just says they're on the list;
  the dashboard always shows the real number regardless.
- **Resubmitting keeps the original number.** Someone correcting their paragraph does not go to the
  back of the queue.

## Tests

```powershell
node --experimental-strip-types test.mjs
```

Runs the Worker in-process against a fake D1 and a stubbed Resend endpoint — the happy path, the
email content, the withheld-then-shown queue number, mail failures, validation, CORS, rate limiting
and all four admin auth states. **Run it before every deploy.** There is no other gate on this
Worker, and no dev server to fall back on (this project has no spare ports — ADR-401).

## Reading the applications

Open `dashboard.html` from disk — double-click it, or:

```powershell
start D:\llama-turbo\signup-worker\dashboard.html
```

Paste the Worker URL and the admin token once; the browser remembers both. It shows totals, a
per-platform breakdown, a 30-day chart, and every application with the paragraph they wrote, plus
"copy all emails" and CSV export that respect the current filter.

It is deliberately not under `docs/site-build/pages/`, so the site generator never sees it and
`wrangler pages deploy` cannot publish it.

## Marking someone as invited

The `invited_at` and `notes` columns exist for tracking who has actually been sent a build. Nothing
writes them automatically:

```powershell
npx wrangler d1 execute turbollm-signup --remote --command "UPDATE signups SET invited_at = unixepoch()*1000 WHERE email = 'someone@example.com'"
```

## Anti-abuse

Four layers, none of which asks a human to solve a puzzle:

- **Honeypot** — a hidden `website` field. Filled in means bot; the submission is dropped.
- **Per-IP limit** — five submissions per hour per hashed IP, counted from the table itself.
- **CORS allow-list** — only `turbollm.dev` and Pages preview deploys get a permissive header.
- **Length caps** — enforced server-side, not just by the form's `maxlength`.

If real spam ever gets through, the next step is Cloudflare Turnstile on the form rather than
tightening any of the above.
