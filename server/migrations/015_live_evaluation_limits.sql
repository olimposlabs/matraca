ALTER TABLE credit_lots ADD COLUMN live_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE credit_reservations ADD COLUMN provider text NOT NULL DEFAULT 'mock' CHECK(provider IN ('mock','openai'));
ALTER TABLE credit_reservations ADD UNIQUE(id,org_id,user_id);

CREATE TABLE credit_reservation_lots (
  reservation_id uuid NOT NULL,
  lot_entry_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount integer NOT NULL CHECK(amount>0),
  PRIMARY KEY(reservation_id,lot_entry_id),
  FOREIGN KEY(reservation_id,org_id,user_id) REFERENCES credit_reservations(id,org_id,user_id),
  FOREIGN KEY(lot_entry_id,org_id,user_id) REFERENCES credit_lots(entry_id,org_id,user_id)
);
CREATE INDEX reservation_lots_wallet ON credit_reservation_lots(org_id,user_id,lot_entry_id);

CREATE TABLE live_evaluation_policies (
  org_id uuid PRIMARY KEY REFERENCES orgs(id),
  enabled boolean NOT NULL,
  organization_limits jsonb NOT NULL CHECK(jsonb_typeof(organization_limits)='object'),
  student_limits jsonb NOT NULL CHECK(jsonb_typeof(student_limits)='object'),
  revision integer NOT NULL CHECK(revision>0)
);

CREATE TABLE live_evaluation_members (
  org_id uuid NOT NULL REFERENCES live_evaluation_policies(org_id),
  student_id uuid NOT NULL,
  PRIMARY KEY(org_id,student_id),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id)
);

CREATE TABLE live_evaluation_admissions (
  request_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  student_id uuid NOT NULL,
  minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 5),
  remaining_calls integer NOT NULL CHECK(remaining_calls BETWEEN 0 AND 18),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(request_id,org_id,student_id) REFERENCES evaluation_requests(id,org_id,student_id)
);
CREATE INDEX live_evaluation_admissions_window ON live_evaluation_admissions(created_at,org_id,student_id);

-- A receipt spends budget before network dispatch. Retries cannot reclaim it.
CREATE TABLE live_evaluation_dispatches (
  request_id uuid NOT NULL REFERENCES live_evaluation_admissions(request_id),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  call_index integer NOT NULL CHECK(call_index BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(request_id,attempt,call_index)
);
CREATE INDEX live_evaluation_dispatches_window ON live_evaluation_dispatches(created_at);

UPDATE credit_reservations w SET provider=r.provider
FROM evaluation_requests r
WHERE w.request_id=r.id::text AND w.org_id=r.org_id AND w.user_id=r.student_id AND r.provider='openai';

-- Close in-flight real requests from the previous, unbudgeted runtime.
WITH released AS (
  UPDATE credit_reservations w SET status='released', settled_at=clock_timestamp(),
    release_reason='Autorização de avaliação real precisa ser renovada'
  FROM evaluation_requests r
  WHERE r.provider='openai' AND r.status IN ('queued','processing')
    AND w.org_id=r.org_id AND w.user_id=r.student_id AND w.request_id=r.id::text
    AND w.status='reserved'
  RETURNING w.org_id,w.user_id,w.amount
), totals AS (
  SELECT org_id,user_id,sum(amount)::integer AS amount FROM released GROUP BY org_id,user_id
)
UPDATE wallets w SET reserved=w.reserved-totals.amount,updated_at=clock_timestamp()
FROM totals WHERE totals.org_id=w.org_id AND totals.user_id=w.user_id;

WITH closed AS (
  UPDATE evaluation_requests SET status='failed',error_code='authorization',
    completed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE provider='openai' AND status IN ('queued','processing') RETURNING id
), jobs AS (
  UPDATE evaluation_jobs j SET state='done',lease_token=NULL,lease_until=NULL
  FROM closed WHERE j.request_id=closed.id RETURNING j.request_id
)
INSERT INTO evaluation_outbox(request_id,event_type)
SELECT id,'failed' FROM closed ON CONFLICT DO NOTHING;
