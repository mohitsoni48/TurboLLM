-- TurboLLM telemetry — D1 raw mirror (ADR-299 Decision 3).
--
-- This is the OWNED copy. PostHog answers funnel/retention questions, but it is
-- a vendor: this table is what makes switching vendors survivable and what the
-- public benchmark-page generator (ADR-006) actually reads.
--
-- Deliberately schema-light. The full validated event is kept verbatim as JSON
-- and the columns are only what we need to index on. Nothing reaches this table
-- without passing validateEvent(), so "verbatim" is bounded by the allow-list
-- rather than being a free-form dump.
--
-- Apply:  wrangler d1 execute turbollm-telemetry --file=schema.sql

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  event       TEXT NOT NULL,
  -- NULL for consent_choice, which carries no machine id by design. That is
  -- the point of it, not a gap: it is the only event an opted-out machine
  -- sends, so it must not be attributable.
  machine_id  TEXT,
  payload     TEXT NOT NULL
);

-- Journey queries are "what happened for this install, in order".
CREATE INDEX IF NOT EXISTS idx_events_machine ON events (machine_id, received_at);

-- Funnel and daily-active queries slice by event name over a time range.
CREATE INDEX IF NOT EXISTS idx_events_name_time ON events (event, received_at);

-- No IP column, no user column, no session column. There is nothing here to
-- join against an identity, which is what makes the consent copy true.

-- The never-silent-drop fix (ADR-331/333). Everything `validateEvent` rejects
-- for an ALLOW-LIST reason (unknown event name, unknown field, invalid enum
-- value) but that still passes `structuralSanityCheck` — meaning it is
-- plausibly real data from a schema this Worker's deployed snapshot hasn't
-- caught up to yet, not something malformed or hostile — lands here instead
-- of being destroyed. Never forwarded to PostHog. Replayable by hand after a
-- redeploy: re-POST the `raw` column's contents once `validateEvent` accepts
-- them. `first_chat` and `failReason` (ADR-331) would have landed here for
-- the two days the Worker was stale, instead of vanishing with no record at
-- all — that is the entire point of this table.
CREATE TABLE IF NOT EXISTS quarantine (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  -- Nullable: `structuralSanityCheck` only requires a plausible identifier
  -- shape, not membership in EVENT_NAMES, so this is exactly the raw string
  -- the client sent, kept for triage even if it never resolves to a real name.
  event_name  TEXT,
  reason      TEXT NOT NULL,
  machine_id  TEXT,
  raw         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quarantine_time ON quarantine (received_at);
CREATE INDEX IF NOT EXISTS idx_quarantine_event ON quarantine (event_name, received_at);
