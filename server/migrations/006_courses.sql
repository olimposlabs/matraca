CREATE TABLE courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id),
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  source_course_id UUID REFERENCES courses(id), draft_revision INTEGER NOT NULL DEFAULT 0,
  draft JSONB NOT NULL CHECK(jsonb_typeof(draft)='object'), created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id,org_id)
);
CREATE TABLE course_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL,
  course_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'), published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(course_id,org_id) REFERENCES courses(id,org_id),
  UNIQUE(course_id,version), UNIQUE(id,org_id), UNIQUE(id,course_id,org_id)
);
CREATE TABLE course_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, course_id UUID NOT NULL,
  version_id UUID NOT NULL, class_id UUID, student_id UUID, assigned_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(version_id,course_id,org_id) REFERENCES course_versions(id,course_id,org_id),
  FOREIGN KEY(class_id,org_id) REFERENCES classes(id,org_id), FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id),
  CHECK((class_id IS NULL)<>(student_id IS NULL)),
  UNIQUE(version_id,class_id), UNIQUE(version_id,student_id)
);
CREATE TABLE course_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, course_id UUID NOT NULL,
  version_id UUID NOT NULL, student_id UUID NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
  source TEXT NOT NULL CHECK(source IN ('assignment','purchase','demo')), source_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
  FOREIGN KEY(version_id,course_id,org_id) REFERENCES course_versions(id,course_id,org_id),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id),
  UNIQUE(course_id,student_id), UNIQUE(id,org_id,student_id)
);
CREATE TABLE course_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, course_id UUID NOT NULL,
  object_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
  byte_length BIGINT NOT NULL CHECK(byte_length>0), created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(course_id,org_id) REFERENCES courses(id,org_id), UNIQUE(id,org_id,course_id)
);
CREATE FUNCTION course_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published course versions are immutable'; END;
$$;
CREATE TRIGGER course_versions_append_only BEFORE UPDATE OR DELETE ON course_versions FOR EACH ROW EXECUTE FUNCTION course_versions_immutable();
