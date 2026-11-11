CREATE TABLE course_unit_progress (
  enrollment_id uuid NOT NULL,
  version_id uuid NOT NULL,
  org_id uuid NOT NULL,
  student_id uuid NOT NULL,
  unit_id text NOT NULL CHECK (length(unit_id) BETWEEN 1 AND 100),
  checked_indices integer[] NOT NULL DEFAULT '{}',
  studied_at timestamptz,
  completed_at timestamptz,
  evaluation_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (enrollment_id,unit_id),
  FOREIGN KEY (enrollment_id,version_id,org_id,student_id) REFERENCES course_enrollments(id,version_id,org_id,student_id),
  FOREIGN KEY (evaluation_id,org_id,student_id) REFERENCES evaluation_requests(id,org_id,student_id),
  CHECK (completed_at IS NULL OR studied_at IS NOT NULL),
  CHECK (evaluation_id IS NULL OR completed_at IS NOT NULL)
);

CREATE TABLE learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL,
  org_id uuid NOT NULL,
  student_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('lesson','review','course')),
  subject_id text NOT NULL,
  group_ids uuid[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id,org_id,student_id) REFERENCES course_enrollments(id,org_id,student_id),
  UNIQUE (enrollment_id,kind,subject_id)
);
CREATE INDEX learning_events_org_time ON learning_events(org_id,occurred_at,student_id);
