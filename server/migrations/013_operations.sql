CREATE TABLE operation_policies (
  org_id uuid PRIMARY KEY REFERENCES orgs(id),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
