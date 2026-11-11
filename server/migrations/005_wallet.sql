CREATE TABLE wallets (
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 1000000000),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= balance),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,user_id),
  FOREIGN KEY (user_id,org_id) REFERENCES users(id,org_id)
);
CREATE TABLE wallet_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  kind TEXT NOT NULL CHECK (kind IN ('grant','consumption','refund','adjustment')),
  source TEXT NOT NULL CHECK (source IN ('initial','lesson','module','course','purchase','manual','leaderboard','evaluation','refund','adjustment')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 160),
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  fingerprint TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  reverses_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id,user_id) REFERENCES wallets(org_id,user_id),
  UNIQUE (org_id,event_key),
  UNIQUE (id,org_id,user_id),
  UNIQUE (reverses_entry_id),
  FOREIGN KEY (reverses_entry_id,org_id,user_id) REFERENCES wallet_entries(id,org_id,user_id),
  CHECK ((kind='refund') = (reverses_entry_id IS NOT NULL)),
  CHECK ((kind='consumption' AND delta<0) OR (kind IN ('grant','refund') AND delta>0) OR kind='adjustment')
);
CREATE INDEX wallet_entries_user ON wallet_entries(org_id,user_id,created_at DESC,id);
CREATE TABLE credit_lots (
  entry_id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity>0),
  remaining INTEGER NOT NULL CHECK (remaining>=0 AND remaining<=quantity),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id,user_id) REFERENCES wallets(org_id,user_id),
  FOREIGN KEY (entry_id,org_id,user_id) REFERENCES wallet_entries(id,org_id,user_id),
  UNIQUE (entry_id,org_id,user_id)
);
CREATE INDEX credit_lots_fifo ON credit_lots(org_id,user_id,created_at,entry_id) WHERE remaining>0;
CREATE TABLE credit_allocations (
  debit_entry_id UUID NOT NULL,
  lot_entry_id UUID NOT NULL,
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  amount INTEGER NOT NULL CHECK (amount>0),
  PRIMARY KEY (debit_entry_id,lot_entry_id),
  FOREIGN KEY (debit_entry_id,org_id,user_id) REFERENCES wallet_entries(id,org_id,user_id),
  FOREIGN KEY (lot_entry_id,org_id,user_id) REFERENCES credit_lots(entry_id,org_id,user_id)
);
CREATE TABLE credit_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 160),
  duration_us BIGINT NOT NULL CHECK (duration_us>0),
  amount INTEGER NOT NULL CHECK (amount>0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','consumed','released')),
  consumption_entry_id UUID UNIQUE,
  release_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  FOREIGN KEY (org_id,user_id) REFERENCES wallets(org_id,user_id),
  FOREIGN KEY (consumption_entry_id,org_id,user_id) REFERENCES wallet_entries(id,org_id,user_id),
  UNIQUE (org_id,request_id),
  CHECK ((status='consumed') = (consumption_entry_id IS NOT NULL)),
  CHECK ((status='reserved') = (settled_at IS NULL))
);
CREATE INDEX credit_reservations_user ON credit_reservations(org_id,user_id,created_at DESC);
CREATE FUNCTION wallet_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Wallet entries are append-only'; END;
$$;
CREATE TRIGGER wallet_entries_append_only BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_entries_immutable();

CREATE TABLE org_credit_policies (
  org_id UUID PRIMARY KEY REFERENCES orgs(id),
  school_extras_enabled BOOLEAN NOT NULL DEFAULT false,
  default_school_monthly_limit INTEGER NOT NULL DEFAULT 0 CHECK(default_school_monthly_limit BETWEEN 0 AND 1000000000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE school_credit_limits (
  org_id UUID NOT NULL, school_id UUID NOT NULL,
  monthly_limit INTEGER NOT NULL CHECK(monthly_limit BETWEEN 0 AND 1000000000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(org_id,school_id),
  FOREIGN KEY(school_id,org_id) REFERENCES schools(id,org_id)
);
CREATE TABLE credit_grant_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  amount INTEGER NOT NULL CHECK(amount BETWEEN 1 AND 1000000),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=500),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id,org_id)
);
CREATE TABLE credit_admin_events (
  org_id UUID NOT NULL, event_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('grant','adjust','refund')),
  user_id UUID NOT NULL, actor_user_id UUID NOT NULL REFERENCES users(id),
  school_id UUID, budget_month DATE,
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  entry_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,event_id),
  FOREIGN KEY(user_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(school_id,org_id) REFERENCES schools(id,org_id),
  FOREIGN KEY(entry_id,org_id,user_id) REFERENCES wallet_entries(id,org_id,user_id),
  CHECK((school_id IS NULL)=(budget_month IS NULL)),
  CHECK(school_id IS NULL OR operation='grant')
);
CREATE INDEX school_credit_usage ON credit_admin_events(org_id,school_id,budget_month) WHERE school_id IS NOT NULL;
