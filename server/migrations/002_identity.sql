CREATE TABLE orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK (kind IN ('matraca', 'partner', 'backoffice')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  branding JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(branding) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE domains (
  hostname TEXT PRIMARY KEY CHECK (hostname = lower(hostname) AND hostname ~ '^[a-z0-9][a-z0-9.-]*$'),
  org_id UUID NOT NULL REFERENCES orgs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hostname, org_id)
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  roles TEXT[] NOT NULL DEFAULT ARRAY['student']::text[] CHECK (
    cardinality(roles) > 0 AND array_position(roles, NULL) IS NULL AND
    roles <@ ARRAY['student', 'teacher', 'school', 'org_admin', 'operator']::text[]
  ),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended')),
  profile JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, email),
  UNIQUE (id, org_id)
);

CREATE TABLE auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  hostname TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'invite')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id),
  FOREIGN KEY (hostname, org_id) REFERENCES domains(hostname, org_id),
  CHECK (expires_at > created_at)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  hostname TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id),
  FOREIGN KEY (hostname, org_id) REFERENCES domains(hostname, org_id),
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_tokens_expiry ON auth_tokens (expires_at) WHERE used_at IS NULL;
CREATE INDEX sessions_user ON sessions (org_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  actor_user_id UUID,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (actor_user_id, org_id) REFERENCES users(id, org_id)
);
CREATE INDEX audit_events_org_created ON audit_events (org_id, created_at DESC);

CREATE TABLE auth_rate_limits (
  key_hash TEXT PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);
