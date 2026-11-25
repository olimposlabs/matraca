CREATE TABLE upload_reservations (
  object_key TEXT PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  bytes BIGINT NOT NULL CHECK (bytes BETWEEN 1 AND 209715200),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX upload_reservations_expiry ON upload_reservations(expires_at);

CREATE VIEW stored_uploads AS
  SELECT object_key,org_id,student_id AS actor_id,byte_length AS bytes,created_at FROM recordings
  UNION ALL SELECT object_key,org_id,created_by,byte_length,created_at FROM course_assets
  UNION ALL SELECT key,org_id,created_by,bytes,created_at FROM logo_assets;

CREATE TABLE upload_admissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  actor_id UUID REFERENCES users(id),
  quantity INTEGER NOT NULL CHECK (quantity>0),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX upload_admissions_recent ON upload_admissions(admitted_at);
INSERT INTO upload_admissions(org_id,actor_id,quantity,admitted_at)
SELECT org_id,actor_id,1,created_at FROM stored_uploads WHERE created_at>clock_timestamp()-interval '24 hours';
