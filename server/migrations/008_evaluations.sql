CREATE TABLE evaluation_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id),
  student_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  client_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  scenario text NOT NULL CHECK (scenario IN ('success','delay','transient','permanent','timeout','invalid')),
  context jsonb NOT NULL CHECK (jsonb_typeof(context)='object'),
  credits integer NOT NULL CHECK (credits > 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id,org_id,student_id),
  UNIQUE (org_id,student_id,client_key),
  FOREIGN KEY (student_id,org_id) REFERENCES users(id,org_id),
  FOREIGN KEY (recording_id,org_id,student_id) REFERENCES recordings(id,org_id,student_id),
  CHECK ((status IN ('completed','failed','cancelled')) = (completed_at IS NOT NULL)),
  CHECK ((status='failed') = (error_code IS NOT NULL))
);
CREATE INDEX evaluation_requests_student_idx ON evaluation_requests(org_id,student_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX evaluation_requests_active_idx ON evaluation_requests(org_id,student_id,recording_id) WHERE status IN ('queued','processing');

CREATE TABLE evaluation_jobs (
  request_id uuid PRIMARY KEY REFERENCES evaluation_requests(id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','done')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  CHECK ((lease_token IS NOT NULL) = (state='leased')),
  CHECK ((lease_until IS NOT NULL) = (state='leased'))
);
CREATE INDEX evaluation_jobs_available_idx ON evaluation_jobs(state,available_at,lease_until) WHERE state <> 'done';

CREATE TABLE evaluation_results (
  request_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  student_id uuid NOT NULL,
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object'),
  consumption_entry_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id,org_id,student_id) REFERENCES evaluation_requests(id,org_id,student_id),
  FOREIGN KEY (consumption_entry_id,org_id,student_id) REFERENCES wallet_entries(id,org_id,user_id)
);

CREATE TABLE evaluation_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES evaluation_requests(id),
  event_type text NOT NULL CHECK (event_type IN ('queued','completed','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,event_type)
);
