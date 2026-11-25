ALTER TABLE recordings ADD COLUMN media_retired_at TIMESTAMPTZ;
ALTER TABLE recordings ADD COLUMN media_removed_at TIMESTAMPTZ;
ALTER TABLE recordings ADD CHECK(media_removed_at IS NULL OR media_retired_at IS NOT NULL);
ALTER TABLE evaluation_results ADD COLUMN report_removed_at TIMESTAMPTZ;
ALTER TABLE evaluation_results ADD CHECK(report_removed_at IS NULL OR report='{}'::jsonb);
CREATE INDEX evaluation_report_retention ON evaluation_results(created_at,request_id) WHERE report_removed_at IS NULL;
CREATE INDEX recording_retention ON recordings(created_at,id) WHERE media_removed_at IS NULL;
CREATE OR REPLACE VIEW stored_uploads AS
  SELECT object_key,org_id,student_id AS actor_id,byte_length AS bytes,created_at FROM recordings WHERE media_removed_at IS NULL
  UNION ALL SELECT object_key,org_id,created_by,byte_length,created_at FROM course_assets
  UNION ALL SELECT key,org_id,created_by,bytes,created_at FROM logo_assets;

ALTER TABLE live_evaluation_policies ADD COLUMN include_experience BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE evaluation_requests ADD UNIQUE(id,org_id,student_id,recording_id);
CREATE TABLE live_evaluation_consents (
  request_id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  student_id UUID NOT NULL,
  recording_id UUID NOT NULL,
  include_experience BOOLEAN NOT NULL DEFAULT false,
  notice_version TEXT NOT NULL CHECK(length(notice_version) BETWEEN 1 AND 100),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY(request_id,org_id,student_id,recording_id) REFERENCES evaluation_requests(id,org_id,student_id,recording_id)
);

-- Requests made before the notice cannot continue on behalf of the learner.
WITH released AS (
  UPDATE credit_reservations w SET status='released',settled_at=clock_timestamp(),release_reason='Confirmação de envio à OpenAI precisa ser renovada'
  FROM evaluation_requests r WHERE r.provider='openai' AND r.status IN ('queued','processing')
    AND (w.request_id,w.org_id,w.user_id)=(r.id::text,r.org_id,r.student_id) AND w.status='reserved'
  RETURNING w.org_id,w.user_id,w.amount
), totals AS (
  SELECT org_id,user_id,sum(amount)::integer AS amount FROM released GROUP BY org_id,user_id
)
UPDATE wallets w SET reserved=w.reserved-totals.amount,updated_at=clock_timestamp()
FROM totals WHERE (totals.org_id,totals.user_id)=(w.org_id,w.user_id);

WITH closed AS (
  UPDATE evaluation_requests SET status='failed',error_code='authorization',
    completed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE provider='openai' AND status IN ('queued','processing') RETURNING id
), jobs AS (
  UPDATE evaluation_jobs j SET state='done',lease_token=NULL,lease_until=NULL
  FROM closed WHERE j.request_id=closed.id RETURNING j.request_id
), budget AS (
  UPDATE live_evaluation_admissions b SET remaining_calls=0 FROM closed WHERE b.request_id=closed.id
)
INSERT INTO evaluation_outbox(request_id,event_type)
SELECT id,'failed' FROM closed ON CONFLICT DO NOTHING;

UPDATE evaluation_requests SET context=jsonb_set(context,'{learner}','{}'::jsonb) WHERE provider='openai' AND context ? 'learner';

CREATE TABLE sensitive_access_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('recording_media','evaluation_report','evaluation_history')),
  target_id UUID,
  outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied','unavailable')),
  reason TEXT CHECK(reason IN ('scope_denied','not_found','retention','report_unavailable')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  bucket TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(actor_id,org_id) REFERENCES users(id,org_id),
  UNIQUE NULLS NOT DISTINCT(org_id,actor_id,action,target_id,outcome,reason,bucket)
);
CREATE INDEX sensitive_access_org ON sensitive_access_events(org_id,occurred_at DESC);
CREATE INDEX sensitive_access_retention ON sensitive_access_events(occurred_at);

ALTER TABLE orgs ADD COLUMN privacy_erasure_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN privacy_erasure_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN privacy_erased_at TIMESTAMPTZ;
ALTER TABLE users ADD CHECK(privacy_erased_at IS NULL OR privacy_erasure_started_at IS NOT NULL);

CREATE FUNCTION preserve_privacy_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.privacy_erasure_started_at IS NOT NULL AND (
    NEW.privacy_erasure_started_at IS DISTINCT FROM OLD.privacy_erasure_started_at OR NEW.status<>'suspended'
  ) THEN
    RAISE EXCEPTION 'O acesso foi encerrado pela política de retenção' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_erased_account BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION preserve_privacy_erasure();
CREATE TRIGGER preserve_erased_organization BEFORE UPDATE ON orgs
  FOR EACH ROW EXECUTE FUNCTION preserve_privacy_erasure();

CREATE FUNCTION preserve_erased_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.privacy_erased_at IS NOT NULL AND
    (NEW.privacy_erased_at IS DISTINCT FROM OLD.privacy_erased_at OR NEW.archived_at IS NULL
     OR NEW.email IS DISTINCT FROM OLD.email OR NEW.name IS DISTINCT FROM OLD.name OR NEW.profile<>'{}'::jsonb) THEN
    RAISE EXCEPTION 'O perfil foi removido pela política de retenção' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_erased_profile BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION preserve_erased_profile();

CREATE OR REPLACE FUNCTION mentoring_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND current_setting('matraca.privacy_maintenance',true)='on' AND
    current_user=(SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=TG_RELID)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Mentoring records are append-only';
END;
$$;
