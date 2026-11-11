ALTER TABLE course_enrollments ADD CONSTRAINT course_enrollment_recording_version
  UNIQUE(id,version_id,org_id,student_id);

CREATE TABLE recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  student_id UUID NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 180),
  mime_type TEXT NOT NULL,
  byte_length BIGINT NOT NULL CHECK(byte_length>0 AND byte_length<=209715200),
  duration_us BIGINT NOT NULL CHECK(duration_us>0 AND duration_us<=1800000000),
  has_audio BOOLEAN NOT NULL,
  has_video BOOLEAN NOT NULL,
  container TEXT NOT NULL CHECK(container IN ('mp4','webm','wav','mp3')),
  probe JSONB NOT NULL CHECK(jsonb_typeof(probe)='object'),
  objective TEXT NOT NULL CHECK(length(objective) BETWEEN 1 AND 2000),
  purpose TEXT NOT NULL CHECK(purpose IN ('free','diagnostic','course')),
  enrollment_id UUID,
  version_id UUID,
  unit_id TEXT CHECK(length(unit_id) BETWEEN 1 AND 100),
  scenario TEXT NOT NULL CHECK(scenario IN ('one_on_one','executive','audience')),
  maximum_seconds INTEGER NOT NULL CHECK(maximum_seconds BETWEEN 1 AND 1800),
  source TEXT NOT NULL CHECK(source IN ('upload','capture')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,org_id,student_id),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(enrollment_id,version_id,org_id,student_id)
    REFERENCES course_enrollments(id,version_id,org_id,student_id),
  CHECK(has_audio OR has_video),
  CHECK(duration_us<=maximum_seconds::bigint*1000000),
  CHECK((purpose='course' AND enrollment_id IS NOT NULL AND version_id IS NOT NULL AND unit_id IS NOT NULL)
     OR (purpose<>'course' AND enrollment_id IS NULL AND version_id IS NULL AND unit_id IS NULL))
);
CREATE INDEX recordings_student ON recordings(org_id,student_id,created_at DESC,id);
