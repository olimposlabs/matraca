CREATE TABLE mentoring_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, student_id UUID NOT NULL,
  teacher_id UUID NOT NULL, client_key UUID NOT NULL, fingerprint TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, evaluation_id UUID, difficulties JSONB NOT NULL,
  guidance TEXT NOT NULL, actions JSONB NOT NULL, follow_up_on DATE, supersedes_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(teacher_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(evaluation_id,org_id,student_id) REFERENCES evaluation_requests(id,org_id,student_id),
  UNIQUE(id,org_id,student_id), UNIQUE(org_id,teacher_id,client_key),
  FOREIGN KEY(supersedes_id,org_id,student_id) REFERENCES mentoring_sessions(id,org_id,student_id),
  CHECK(jsonb_typeof(difficulties)='array' AND jsonb_typeof(actions)='array'),
  CHECK(length(guidance) BETWEEN 1 AND 10000)
);
CREATE INDEX mentoring_sessions_student ON mentoring_sessions(org_id,student_id,occurred_at DESC,id);

CREATE TABLE human_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, student_id UUID NOT NULL,
  teacher_id UUID NOT NULL, evaluation_id UUID NOT NULL, client_key UUID NOT NULL, fingerprint TEXT NOT NULL,
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 10000),
  observations JSONB NOT NULL CHECK(jsonb_typeof(observations)='array'), supersedes_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(teacher_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(evaluation_id,org_id,student_id) REFERENCES evaluation_requests(id,org_id,student_id),
  UNIQUE(id,org_id,student_id), UNIQUE(org_id,teacher_id,client_key),
  FOREIGN KEY(supersedes_id,org_id,student_id) REFERENCES human_reviews(id,org_id,student_id)
);
CREATE INDEX human_reviews_student ON human_reviews(org_id,student_id,created_at DESC,id);

CREATE TABLE individual_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, student_id UUID NOT NULL,
  created_by UUID NOT NULL, client_key UUID NOT NULL, fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('task','goal')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180), description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','cancelled')),
  due_on DATE, mentoring_session_id UUID, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(created_by,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(mentoring_session_id,org_id,student_id) REFERENCES mentoring_sessions(id,org_id,student_id),
  UNIQUE(id,org_id,student_id), UNIQUE(org_id,created_by,client_key)
);
CREATE INDEX individual_plan_student ON individual_plan_items(org_id,student_id,created_at DESC,id);

CREATE TABLE individual_plan_history (
  item_id UUID NOT NULL, org_id UUID NOT NULL, student_id UUID NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  actor_id UUID NOT NULL, actor_roles TEXT[] NOT NULL, snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  response TEXT NOT NULL DEFAULT '' CHECK(length(response)<=5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(item_id,revision),
  FOREIGN KEY(item_id,org_id,student_id) REFERENCES individual_plan_items(id,org_id,student_id),
  FOREIGN KEY(actor_id,org_id) REFERENCES users(id,org_id)
);

CREATE FUNCTION mentoring_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Mentoring records are append-only'; END;
$$;
CREATE TRIGGER mentoring_sessions_append_only BEFORE UPDATE OR DELETE ON mentoring_sessions
  FOR EACH ROW EXECUTE FUNCTION mentoring_record_immutable();
CREATE TRIGGER human_reviews_append_only BEFORE UPDATE OR DELETE ON human_reviews
  FOR EACH ROW EXECUTE FUNCTION mentoring_record_immutable();
CREATE TRIGGER individual_plan_history_append_only BEFORE UPDATE OR DELETE ON individual_plan_history
  FOR EACH ROW EXECUTE FUNCTION mentoring_record_immutable();
