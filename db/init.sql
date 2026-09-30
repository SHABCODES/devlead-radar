-- CRM tables for Lead Radar. Runs automatically on first start of the postgres container.
CREATE TABLE IF NOT EXISTS leads (
  id             BIGSERIAL PRIMARY KEY,
  domain         TEXT NOT NULL UNIQUE,          -- dedupe key
  company        TEXT NOT NULL,
  github_org     TEXT,
  contact_name   TEXT,
  contact_email  TEXT,
  source         TEXT,
  status         TEXT NOT NULL,                 -- scored | no_github_data | needs_retry
  final_score    SMALLINT CHECK (final_score BETWEEN 1 AND 5),
  score_source   TEXT,                          -- llm | rules_fallback
  llm_score      SMALLINT,
  llm_confidence TEXT,
  reason         TEXT,
  opener         TEXT,
  rule_score     SMALLINT,
  rule_tier      SMALLINT,
  needs_review   BOOLEAN NOT NULL DEFAULT FALSE,
  signals        JSONB,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_score_idx ON leads (final_score DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS workflow_errors (
  id           BIGSERIAL PRIMARY KEY,
  workflow     TEXT,
  node         TEXT,
  message      TEXT,
  execution_id TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Handy view: what a rep would work through first.
CREATE OR REPLACE VIEW hot_leads AS
SELECT company, domain, final_score, reason, opener, needs_review, updated_at
FROM leads
WHERE status = 'scored' AND final_score >= 4
ORDER BY needs_review ASC, final_score DESC, updated_at DESC;
