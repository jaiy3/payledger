-- PayLedger schema.
-- Money is stored as BIGINT minor units (kobo). Never floats.
-- The rules that keep the ledger correct are enforced here, in the database,
-- not only in application code:
--   1. every journal entry has at least two postings and sums to zero
--   2. customer balances can never go negative
--   3. journal entries and postings are append-only

CREATE TABLE workspaces (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  api_key_hash   text NOT NULL UNIQUE,
  api_key_prefix text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE account_type AS ENUM ('customer', 'settlement', 'fees');

CREATE TABLE accounts (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           text NOT NULL,
  type           account_type NOT NULL DEFAULT 'customer',
  currency       char(3) NOT NULL DEFAULT 'NGN',
  balance        bigint NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Backstop for the application-level funds check.
  CONSTRAINT balance_non_negative CHECK (allow_negative OR balance >= 0)
);
CREATE INDEX accounts_workspace_idx ON accounts (workspace_id, created_at);

CREATE TYPE entry_type AS ENUM ('deposit', 'transfer');

CREATE TABLE journal_entries (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         entry_type NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_workspace_idx ON journal_entries (workspace_id, created_at DESC, id DESC);

CREATE TABLE postings (
  id            bigserial PRIMARY KEY,
  entry_id      text NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id    text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount        bigint NOT NULL CHECK (amount <> 0),
  balance_after bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX postings_account_idx ON postings (account_id, id DESC);
CREATE INDEX postings_entry_idx ON postings (entry_id);

-- Rule 1: checked at COMMIT (deferred), once all postings of the entry exist.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
  legs  int;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO total, legs
  FROM postings WHERE entry_id = NEW.id;

  IF legs < 2 THEN
    RAISE EXCEPTION 'journal entry % has % posting(s); at least 2 are required', NEW.id, legs
      USING ERRCODE = 'check_violation';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: postings sum to %', NEW.id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Postings added to an existing entry later must also keep it balanced.
CREATE FUNCTION assert_posting_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total FROM postings WHERE entry_id = NEW.entry_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: postings sum to %', NEW.entry_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER postings_balanced
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_posting_entry_balanced();

-- Rule 3: the ledger is append-only. Corrections are new entries, never edits.
-- The only exception is the sandbox purge job, which sets payledger.allow_purge.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('payledger.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- Idempotency: one row per (workspace, key), storing the first response.
CREATE TABLE idempotency_keys (
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

-- Webhooks (transactional outbox).
CREATE TABLE webhook_endpoints (
  id                     text PRIMARY KEY,
  workspace_id           text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url                    text NOT NULL,
  secret                 text NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  simulated_failure_rate real NOT NULL DEFAULT 0
    CHECK (simulated_failure_rate >= 0 AND simulated_failure_rate <= 1),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id               text PRIMARY KEY,
  event_id         text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  endpoint_id      text NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'retrying', 'succeeded', 'dead')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_status_code int,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'retrying', 'sending');
CREATE INDEX webhook_deliveries_workspace_idx ON webhook_deliveries (workspace_id, created_at DESC);
