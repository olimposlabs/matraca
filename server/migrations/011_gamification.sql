ALTER TABLE learning_events ADD CONSTRAINT learning_event_owner UNIQUE (id,org_id,student_id);

CREATE TABLE gamification_policies (
  org_id uuid PRIMARY KEY REFERENCES orgs(id),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE xp_events (
  learning_event_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  student_id uuid NOT NULL,
  points integer NOT NULL CHECK (points BETWEEN 0 AND 100000),
  policy_revision integer NOT NULL CHECK (policy_revision>=0),
  FOREIGN KEY (learning_event_id,org_id,student_id) REFERENCES learning_events(id,org_id,student_id)
);
CREATE INDEX xp_events_student ON xp_events(org_id,student_id);

CREATE TABLE earned_badges (
  org_id uuid NOT NULL,
  student_id uuid NOT NULL,
  badge_id text NOT NULL,
  learning_event_id uuid NOT NULL,
  name text NOT NULL,
  condition jsonb NOT NULL,
  earned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id,student_id,badge_id),
  FOREIGN KEY (learning_event_id,org_id,student_id) REFERENCES learning_events(id,org_id,student_id)
);

CREATE TABLE prize_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  group_id uuid,
  client_key uuid NOT NULL,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  prizes jsonb NOT NULL CHECK (jsonb_typeof(prizes)='array'),
  closed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,org_id),
  UNIQUE (org_id,client_key),
  FOREIGN KEY (group_id,org_id) REFERENCES education_groups(id,org_id),
  CHECK (ends_at>starts_at)
);

CREATE TABLE ranking_snapshots (
  campaign_id uuid NOT NULL,
  org_id uuid NOT NULL,
  position integer NOT NULL CHECK (position>0),
  student_id uuid NOT NULL,
  student_name text NOT NULL,
  points bigint NOT NULL CHECK (points>0),
  reached_at timestamptz NOT NULL,
  PRIMARY KEY (campaign_id,position),
  UNIQUE (campaign_id,org_id,student_id),
  FOREIGN KEY (campaign_id,org_id) REFERENCES prize_campaigns(id,org_id),
  FOREIGN KEY (student_id,org_id) REFERENCES users(id,org_id)
);

CREATE TABLE ranking_prizes (
  campaign_id uuid NOT NULL,
  org_id uuid NOT NULL,
  student_id uuid NOT NULL,
  entry_id uuid NOT NULL UNIQUE,
  credits integer NOT NULL CHECK (credits>0),
  PRIMARY KEY (campaign_id,student_id),
  FOREIGN KEY (campaign_id,org_id,student_id) REFERENCES ranking_snapshots(campaign_id,org_id,student_id),
  FOREIGN KEY (entry_id,org_id,student_id) REFERENCES wallet_entries(id,org_id,user_id)
);


INSERT INTO xp_events(learning_event_id,org_id,student_id,points,policy_revision)
SELECT id,org_id,student_id,CASE kind WHEN 'lesson' THEN 20 WHEN 'review' THEN 100 ELSE 500 END,0
FROM learning_events;

WITH marks AS (
  SELECT l.id,l.org_id,l.student_id,l.kind,l.occurred_at,
    row_number() OVER (PARTITION BY l.org_id,l.student_id,l.kind ORDER BY l.occurred_at,l.id) AS first_of_kind,
    sum(x.points) OVER (PARTITION BY l.org_id,l.student_id ORDER BY l.occurred_at,l.id) AS total
  FROM learning_events l JOIN xp_events x ON x.learning_event_id=l.id
), possible AS (
  SELECT id,org_id,student_id,occurred_at,
    CASE kind WHEN 'lesson' THEN 'first-lesson' WHEN 'review' THEN 'first-review' ELSE 'first-course' END AS badge_id,
    CASE kind WHEN 'lesson' THEN 'Primeira prática' WHEN 'review' THEN 'Revisão em dia' ELSE 'Jornada concluída' END AS name,
    jsonb_build_object('metric',kind,'threshold',1) AS condition
  FROM marks WHERE first_of_kind=1
  UNION ALL
  SELECT id,org_id,student_id,occurred_at,'xp-500','500 pontos de prática',jsonb_build_object('metric','xp','threshold',500)
  FROM marks WHERE total>=500
)
INSERT INTO earned_badges(org_id,student_id,badge_id,learning_event_id,name,condition,earned_at)
SELECT DISTINCT ON(org_id,student_id,badge_id) org_id,student_id,badge_id,id,name,condition,occurred_at
FROM possible ORDER BY org_id,student_id,badge_id,occurred_at,id;
