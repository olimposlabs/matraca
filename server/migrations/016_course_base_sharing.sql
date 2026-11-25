CREATE TABLE course_base_shares (
  course_id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  version_id UUID NOT NULL,
  FOREIGN KEY(version_id,course_id,org_id) REFERENCES course_versions(id,course_id,org_id)
);

-- Approve only the original curriculum that the pilot already offers as a template.
INSERT INTO course_base_shares(course_id,org_id,version_id)
SELECT v.course_id,v.org_id,v.id FROM course_versions v JOIN orgs o ON o.id=v.org_id
WHERE v.course_id='712e79ec-dcba-426e-a095-a746f5bec121'
  AND v.org_id='9b73dad5-1ab4-478a-a033-d6423435b743'
  AND o.kind='matraca' AND v.version=1 AND v.published_by IS NULL;
