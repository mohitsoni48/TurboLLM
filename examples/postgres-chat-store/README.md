# Postgres ChatStore example

**This is example code, not a supported TurboLLM product.** It exists to prove that
[spec 27's `ChatStore` interface](../../docs/specs/27-external-chat-api.md) is
genuinely implementable outside TurboLLM's own SQLite path, and to give an
integrator something to copy rather than write from scratch.

It implements all 13 required `ChatStore` methods over plain `pg` (node-postgres),
using the typed-columns-plus-one-JSONB-blob layout spec §4.1 describes, and it is
exercised by the exact same conformance suite CI runs against `SqliteChatStore`
(`turbollm/src/chat/store/conformance.ts`) — see `conformance.test.mjs`.

## Capabilities

```js
{ branching: false, folders: false, search: true, batch: false }
```

Stated honestly: this adapter implements neither optional capability group.
`search` is real (`listChats({ q })` filters the typed `title` column). A client
calling a branching- or folder-only endpoint against a daemon configured with this
adapter gets `501 not_supported`, exactly as spec §4.2 documents for an absent
capability — nothing here pretends otherwise.

## Files

| File | Purpose |
|---|---|
| `schema.sql` | The two tables (`chats`, `messages`) and the three indexes spec §4.1 requires. |
| `index.mjs` | The adapter: `PostgresChatStore` plus a default-exported factory matching the `module` adapter kind's contract (spec §4.5). |
| `conformance.test.mjs` | Runs the real conformance suite against this adapter. |
| `docker-compose.yml` | A local Postgres for running the suite, with `schema.sql` auto-applied on first boot. |

## Run it

```bash
cd examples/postgres-chat-store
npm install
docker compose up -d
npm test
```

`npm test` runs `tsx --test conformance.test.mjs` against
`postgres://turbollm:turbollm@localhost:5432/turbollm_chat_example` by default —
override with a `DATABASE_URL` environment variable to point at a different
instance.

**Verification status, stated plainly:** this adapter was written and reviewed
against the real `ChatStore` interface in `turbollm/src/chat/store/chat-store.ts`
line by line (all 13 method signatures cross-checked), and every `.mjs` file here
passes `node --check`. The live run above — an actual Postgres container executing
the real conformance suite — was **not** executed in the environment this example
was authored in (Docker's CLI was present but its engine/daemon was not reachable
there). Treat this adapter as unverified-at-runtime until someone runs the four
commands above for real; that run is the actual proof, not this paragraph.

## On importing `StoreError` from the real interface module

`index.mjs` and `conformance.test.mjs` both import from
`../../turbollm/src/chat/store/chat-store.js` via a relative path rather than
vendoring or redefining that code. That's an interim choice: spec §14 defers
publishing a standalone `@turbollm/chat-store-conformance` package to Phase 5, so
there's nothing on npm yet to depend on instead. Importing the real `StoreError`
class means `instanceof StoreError` checks in `turbollm/src/ext/errors.ts` correctly
recognize errors this adapter throws when it's actually loaded in-process by the
daemon. If you're copying this example into a genuinely separate repository today
(not running it inside this monorepo), vendor the ~10-line `StoreError` class from
`chat-store.ts` — it has no dependencies of its own — rather than inventing an
incompatible one; switch to the real package once Phase 5 ships it.

## A finding, not a fix: `deleteMessage` and `message_count`

While implementing this adapter, `deleteMessage` was written to decrement the
parent chat's `message_count` (and bump `updated_at`) in the same transaction,
because spec §4.2 states plainly that "`message_count`/`last_message_at` are
maintained by `addMessage`/`deleteMessage`, in the same transaction." The actual
reference implementation, `SqliteChatStore.deleteMessage`
(`turbollm/src/chat/store/sqlite-chat-store.ts`), does **not** do this — it deletes
the row and nothing else, which looks like a real gap (a deleted message leaves
`message_count` too high) rather than an intentional simplification. This adapter
follows the written spec rather than silently reproducing that gap. Flagged here
for the spec/implementation owners, not fixed quietly behind the interface's back.

## Point a daemon at this adapter

```jsonc
// config.json
{
  "chatStore": {
    "kind": "module",
    "specifier": "../examples/postgres-chat-store/index.mjs",
    "options": { "connectionString": "postgres://turbollm:turbollm@localhost:5432/turbollm_chat_example" }
  }
}
```

The specifier is resolved relative to the data directory (or as a bare npm package
name) and `import()`ed; its default export must be a factory `(options) => ChatStore
| Promise<ChatStore>` — exactly what `index.mjs` exports. If the adapter fails to
load, fails to export that factory, or fails its `health()` check, **the daemon
refuses to start** rather than silently falling back to SQLite (spec §4.5) — a
broken adapter must be loud, not silently write an integrator's data to the wrong
database.
