CREATE TABLE org_branding_history (
  org_id UUID NOT NULL REFERENCES orgs(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  branding JSONB NOT NULL CHECK (jsonb_typeof(branding) = 'object'),
  actor_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, revision)
);

CREATE TABLE logo_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type = 'image/webp'),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 1024),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 2097152),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX logo_assets_org ON logo_assets (org_id, created_at DESC);

UPDATE orgs SET branding = jsonb_build_object(
  'displayName', name,
  'primary', '#b8442b', 'background', '#faf8f2', 'surface', '#ffffff',
  'text', '#1f2925', 'muted', '#59665f', 'font', 'sans',
  'creditSingular', 'crédito', 'creditPlural', 'créditos'
) || branding || jsonb_build_object(
  '_revision', 0,
  'primary', CASE WHEN branding->>'primary' = '#c95032' THEN '#b8442b'
    ELSE COALESCE(branding->>'primary', '#b8442b') END
);

INSERT INTO org_branding_history (org_id, revision, branding)
SELECT id, 0, branding FROM orgs;
