# turbollm-telemetry — ingest Worker

The receiving half of ADR-299. Accepts the anonymous telemetry the TurboLLM
client sends, mirrors it to D1, and fans it out to PostHog.

Deployed to `t.turbollm.dev` (custom domain) and `turbollm-telemetry.<account>.workers.dev`.

## Why the logic is not in this directory

`src/index.ts` is a shell. All decisions live in
[`../turbollm/src/telemetry/ingest.ts`](../turbollm/src/telemetry/ingest.ts),
which imports the same `schema.ts` the **client** validates against. That shared
import is the entire mechanism behind "client and edge cannot disagree about
what is allowed" (ADR-299 Decision 1), and its tests run in the daemon's suite
(`ingest.test.ts`, `schema.test.ts`) so the guarantee cannot rot unnoticed.

Do not reimplement validation here.

## There is no authentication

Deliberate (ADR-299 Decision 2). A credential shipped inside a source-available
npm package is not a credential — anyone can extract it, and because the
*aggregate* is the product, a leaked write key is a dataset-poisoning primitive
rather than a mere inconvenience. So the endpoint is public and documented as
public, and defence is:

1. Strict schema allow-list — enum-only journey events; the six `bench_result`
   identifier fields are length/charset-capped.
2. Rate limits per machine id and per truncated IP hash (IP never persisted),
   backed by a Durable Object (`rate-limiter-do.ts`) so the limit is exact
   rather than approximate — see the comment above `[[durable_objects.bindings]]`
   in `wrangler.toml` for why two earlier approaches (KV, then Cloudflare's
   native Rate Limiting binding) were tried and rejected.
3. Plausibility filtering on benchmark rows.
4. Defensive analysis downstream — dedupe, drop implausible event rates, report
   ranges rather than exact counts.

Rejected: HMAC-signing with a key baked into the client. That is obfuscation,
not authentication, and claiming otherwise in an open-source product invites a
public disproof.

## Deploy

```bash
wrangler d1 create turbollm-telemetry          # paste id into wrangler.toml
wrangler d1 execute turbollm-telemetry --file=schema.sql
wrangler secret put POSTHOG_KEY
wrangler deploy
```

The `RATE_LIMITER` Durable Object binding and its `new_sqlite_classes`
migration are already declared in `wrangler.toml` — `wrangler deploy` creates
it, no separate `wrangler ... create` step needed (unlike D1/KV).

Set an account spend cap first. A public unauthenticated endpoint should never
be able to cost money — the anti-abuse design assumes a flood is noisy, not
expensive.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /v1/events` | Ingest a batch. Always `202` unless malformed, oversized, or rate-limited. |
| `GET /healthz` | Liveness. |

`202` is returned even when every event in the batch was dropped: telling a
caller *which* events failed validation would hand a prober a free oracle for
mapping the allow-list.
