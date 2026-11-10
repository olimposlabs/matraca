ALTER TABLE users ADD COLUMN archived_at TIMESTAMPTZ;

CREATE TABLE schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id,org_id)
);
CREATE TABLE school_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, school_id UUID NOT NULL, user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('school','teacher')), started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
  FOREIGN KEY (school_id,org_id) REFERENCES schools(id,org_id), FOREIGN KEY (user_id,org_id) REFERENCES users(id,org_id),
  CHECK (ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX school_staff_active ON school_staff(org_id,school_id,user_id,role) WHERE ended_at IS NULL;
CREATE TABLE student_schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, school_id UUID NOT NULL, student_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
  FOREIGN KEY (school_id,org_id) REFERENCES schools(id,org_id), FOREIGN KEY (student_id,org_id) REFERENCES users(id,org_id),
  CHECK (ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX student_current_school ON student_schools(org_id,student_id) WHERE ended_at IS NULL;
CREATE TABLE teacher_profiles (
  org_id UUID NOT NULL, user_id UUID NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','suspended')),
  certifications JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(certifications)='array'),
  approved_by UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,org_id), FOREIGN KEY (user_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY (approved_by,org_id) REFERENCES users(id,org_id)
);
CREATE TABLE classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, school_id UUID NOT NULL,
  name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','archived')),
  starts_on DATE, ends_on DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id,org_id) REFERENCES schools(id,org_id), UNIQUE(id,org_id), UNIQUE(id,org_id,school_id),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on>=starts_on)
);
CREATE TABLE enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, class_id UUID NOT NULL,
  school_id UUID NOT NULL, student_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','transferred','cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
  FOREIGN KEY(class_id,org_id,school_id) REFERENCES classes(id,org_id,school_id),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id),
  CHECK ((status='active' AND ended_at IS NULL) OR (status<>'active' AND ended_at IS NOT NULL)),
  CHECK (ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX enrollment_active ON enrollments(org_id,class_id,student_id) WHERE status='active';
CREATE INDEX enrollments_student ON enrollments(org_id,student_id);
CREATE TABLE teacher_class_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, class_id UUID NOT NULL,
  school_id UUID NOT NULL, teacher_id UUID NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
  FOREIGN KEY(class_id,org_id,school_id) REFERENCES classes(id,org_id,school_id),
  FOREIGN KEY(teacher_id,org_id) REFERENCES users(id,org_id), CHECK(ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX teacher_assignment_active ON teacher_class_assignments(org_id,class_id,teacher_id) WHERE ended_at IS NULL;
CREATE TABLE group_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id), name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK(position>=0), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  UNIQUE(id,org_id)
);
CREATE UNIQUE INDEX group_type_name ON group_types(org_id,lower(name));
CREATE TABLE education_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id), type_id UUID NOT NULL,
  parent_id UUID, school_id UUID, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(id,org_id),
  FOREIGN KEY(type_id,org_id) REFERENCES group_types(id,org_id),
  FOREIGN KEY(parent_id,org_id) REFERENCES education_groups(id,org_id),
  FOREIGN KEY(school_id,org_id) REFERENCES schools(id,org_id), CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE TABLE group_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, group_id UUID NOT NULL, user_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
  FOREIGN KEY(group_id,org_id) REFERENCES education_groups(id,org_id), FOREIGN KEY(user_id,org_id) REFERENCES users(id,org_id),
  CHECK(ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX group_member_active ON group_memberships(org_id,group_id,user_id) WHERE ended_at IS NULL;
CREATE TABLE student_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, student_id UUID NOT NULL,
  from_school_id UUID, to_school_id UUID NOT NULL, reason TEXT NOT NULL DEFAULT '', actor_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY(from_school_id,org_id) REFERENCES schools(id,org_id), FOREIGN KEY(to_school_id,org_id) REFERENCES schools(id,org_id),
  FOREIGN KEY(actor_user_id,org_id) REFERENCES users(id,org_id), CHECK(from_school_id IS NULL OR from_school_id<>to_school_id)
);
