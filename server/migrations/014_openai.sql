-- Requests retain their provider across restarts and mode changes. Historical jobs stay mock.
ALTER TABLE evaluation_requests ADD COLUMN provider text NOT NULL DEFAULT 'mock'
  CHECK(provider IN ('mock','openai'));

-- Metadata only: no prompt, transcript, response body, media or credentials.
-- Captures API attempts even if the final report is invalid or the job is cancelled.
CREATE TABLE evaluation_provider_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES evaluation_requests(id),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX evaluation_provider_calls_request ON evaluation_provider_calls(request_id,created_at);
