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
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

For `ADMIN_TOKEN`, paste a long random string — it is the only thing standing between the public
internet and the applicant list. Generate one with:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

The deploy provisions `signup.turbollm.dev` as a custom domain (a proxied DNS record is created as
part of the deploy, so "deployed" and "reachable" are the same statement). Verify:

```powershell
curl.exe https://signup.turbollm.dev/health
```

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
