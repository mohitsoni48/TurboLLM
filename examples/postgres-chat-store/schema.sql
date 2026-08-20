-- Postgres schema for the example ChatStore adapter (spec 27 "External Chat API +
-- pluggable chat storage", §4.1 "Data layout — typed core plus one opaque blob").
--
-- Two tables, each with a small set of typed, INDEXED columns — only what the store
-- must filter, sort, or join on — plus one opaque `body` JSONB document for
-- everything else. When TurboLLM adds a new per-message/per-chat field, `body`
-- absorbs it and this schema does not need to change (spec §4.1's open/closed
-- argument). Only fields that must be FILTERED or SORTED on ever need to become a
-- typed column, and that is a documented migration, not a silent one.
--
-- This example implements neither optional capability group (no `branching`, no
-- `folders` — see index.mjs's `capabilities` object), so `is_active`, `variant_group`,
-- and `branch_of` are present per the spec's documented layout but are effectively
-- inert here: every message is inserted with `is_active = true` and NULL
-- variant/branch columns, and nothing in this adapter ever changes them. A real
-- BranchingStore implementation would use them for tail freeze/restore and message
-- variants.

CREATE TABLE IF NOT EXISTS chats (
  id               text PRIMARY KEY,
  tenant           text NOT NULL,
  owner            text NOT NULL,
  title            text NOT NULL DEFAULT '',
  -- Reserved per spec §4.1's typed-column list for chats. The current ChatStore
  -- interface's public `Chat` DTO (types.ts) does not expose a chat-level status
  -- field, so this column is unused by anything in this adapter today — kept only
  -- so the schema matches the documented layout for future evolution (e.g. an
  -- archived/soft-deleted state) without a migration when that day comes.
  status           text NOT NULL DEFAULT 'active',
  message_count    integer NOT NULL DEFAULT 0,
  last_message_at  timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Opaque: model, systemPrompt, sampling, metadata — everything a caller round-trips
  -- through ChatInput/ChatPatch that the store never filters or sorts on.
  body             jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS messages (
  id               text PRIMARY KEY,
  tenant           text NOT NULL,
  owner            text NOT NULL,
  chat_id          text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  status           text NOT NULL DEFAULT 'complete',
  is_active        boolean NOT NULL DEFAULT true,
  variant_group    text,
  branch_of        text,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Opaque: content, reasoning, attachments, toolCalls, usage, metadata, edited.
  -- `edited` lives in the blob rather than as a typed column: nothing in the
  -- interface ever filters or sorts on it (spec §4.1's own test for when a field
  -- must become typed), so it stays in the document like content itself.
  body             jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- The three indexes spec §4.1 requires of every adapter:

-- 1. (tenant, owner, chat_id, seq) — message listing, every request. Declared UNIQUE:
--    seq must be gapless-and-distinct per chat (conformance suite asserts this under
--    20 concurrent appends), so a uniqueness violation here would mean the adapter's
--    own seq-allocation transaction (see index.mjs's addMessage) has a bug — this
--    index both serves reads and acts as a live correctness check on writes.
CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_owner_chat_seq_idx
  ON messages (tenant, owner, chat_id, seq);

-- 2. (tenant, owner, updated_at DESC) — chat listing, keyset-paginated newest first.
CREATE INDEX IF NOT EXISTS chats_tenant_owner_updated_at_idx
  ON chats (tenant, owner, updated_at DESC);

-- 3. (tenant, chat_id, variant_group) — branching, when declared. This adapter does
--    not implement BranchingStore (capabilities.branching = false), so the column is
--    always NULL here and this index is presently unused — kept because §4.1 asks
--    for it as part of the documented layout regardless of which capability groups a
--    given adapter opts into, so adding branching later needs no migration.
CREATE INDEX IF NOT EXISTS messages_tenant_chat_variant_group_idx
  ON messages (tenant, chat_id, variant_group);
