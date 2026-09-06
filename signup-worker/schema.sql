-- TurboLLM beta-tester signups (ADR-401).
--
-- One row per person. Re-submitting the same email updates that row instead of
-- creating a second one, so the table is also the mailing list: no dedupe pass
-- is needed before an invite goes out.

CREATE TABLE IF NOT EXISTS signups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,          -- epoch ms, first submission
  updated_at  INTEGER NOT NULL,          -- epoch ms, latest submission
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL UNIQUE,   -- stored lowercased + trimmed
  reason      TEXT    NOT NULL,          -- "why do you want to test this"
  platforms   TEXT    NOT NULL,          -- JSON array, e.g. ["windows","android"]
  source      TEXT,                      -- referrer / utm, if the page had one
  country     TEXT,                      -- Cloudflare's request.cf.country, coarse
  ip_hash     TEXT    NOT NULL,          -- SHA-256 prefix; the IP itself is never stored
  invited_at  INTEGER,                   -- set by hand once an invite actually goes out
  notes       TEXT,                      -- founder's own scratch column

  -- Confirmation email (ADR-403). Written after the response is already sent, so a
  -- mail outage can never fail somebody's signup — it just leaves a visible gap the
  -- dashboard can surface and you can retry.
  email_sent_at INTEGER,
  email_error   TEXT
);

CREATE INDEX IF NOT EXISTS idx_signups_created ON signups(created_at);

-- Backs the per-IP flood check in index.ts, which counts recent rows for one
-- hash rather than standing up a Durable Object: a signup form sees a few
-- submissions a minute at its busiest, so a COUNT over an index is enough and
-- costs no extra infrastructure.
CREATE INDEX IF NOT EXISTS idx_signups_ip ON signups(ip_hash, created_at);
