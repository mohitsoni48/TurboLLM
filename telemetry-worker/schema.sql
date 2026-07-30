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
