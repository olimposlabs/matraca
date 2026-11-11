ALTER TABLE users ADD COLUMN billing_accepted_at TIMESTAMPTZ;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entry_org_reference UNIQUE(id,org_id);
UPDATE users u SET billing_accepted_at=(SELECT min(a.created_at) FROM audit_events a
  WHERE a.org_id=u.org_id AND a.actor_user_id=u.id AND a.event_type='session_started');

CREATE TABLE billing_observation_coverage (
  org_id UUID PRIMARY KEY REFERENCES orgs(id), tracked_since TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO billing_observation_coverage(org_id) SELECT id FROM orgs;
CREATE TABLE billing_school_history (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id UUID NOT NULL, school_id UUID NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), active BOOLEAN NOT NULL,
  FOREIGN KEY(school_id,org_id) REFERENCES schools(id,org_id)
);
CREATE INDEX billing_school_cut ON billing_school_history(org_id,school_id,observed_at DESC,event_id DESC);
INSERT INTO billing_school_history(org_id,school_id,active) SELECT org_id,id,status='active' FROM schools;
CREATE TABLE billing_student_history (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id UUID NOT NULL, user_id UUID NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), active BOOLEAN NOT NULL, student BOOLEAN NOT NULL, accepted BOOLEAN NOT NULL,
  FOREIGN KEY(user_id,org_id) REFERENCES users(id,org_id)
);
CREATE INDEX billing_student_cut ON billing_student_history(org_id,user_id,observed_at DESC,event_id DESC);
INSERT INTO billing_student_history(org_id,user_id,active,student,accepted)
  SELECT org_id,id,status='active' AND archived_at IS NULL,'student'=ANY(roles),billing_accepted_at IS NOT NULL FROM users;
-- Existing entities are known only after the complete baseline was recorded.
UPDATE billing_observation_coverage SET tracked_since=clock_timestamp();

CREATE FUNCTION billing_track_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO billing_observation_coverage(org_id) VALUES(NEW.id); RETURN NEW; END;
$$;
CREATE TRIGGER billing_org_insert AFTER INSERT ON orgs FOR EACH ROW EXECUTE FUNCTION billing_track_org();
CREATE FUNCTION billing_track_school() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO billing_school_history(org_id,school_id,active) VALUES(NEW.org_id,NEW.id,NEW.status='active');
  END IF; RETURN NEW;
END;
$$;
CREATE TRIGGER billing_school_change AFTER INSERT OR UPDATE ON schools FOR EACH ROW EXECUTE FUNCTION billing_track_school();
CREATE FUNCTION billing_track_student() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR (NEW.status,NEW.archived_at,NEW.roles,NEW.billing_accepted_at) IS DISTINCT FROM (OLD.status,OLD.archived_at,OLD.roles,OLD.billing_accepted_at) THEN
    INSERT INTO billing_student_history(org_id,user_id,active,student,accepted)
      VALUES(NEW.org_id,NEW.id,NEW.status='active' AND NEW.archived_at IS NULL,'student'=ANY(NEW.roles),NEW.billing_accepted_at IS NOT NULL);
  END IF; RETURN NEW;
END;
$$;
CREATE TRIGGER billing_student_change AFTER INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION billing_track_student();
CREATE FUNCTION billing_track_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type='session_started' AND NEW.actor_user_id IS NOT NULL THEN
    UPDATE users SET billing_accepted_at=COALESCE(billing_accepted_at,NEW.created_at) WHERE id=NEW.actor_user_id AND org_id=NEW.org_id AND billing_accepted_at IS NULL;
  END IF; RETURN NEW;
END;
$$;
CREATE TRIGGER billing_acceptance AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION billing_track_acceptance();

CREATE TABLE commerce_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180), kind TEXT NOT NULL CHECK(kind IN ('credits','course')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'), course_id UUID, course_version_id UUID,
  created_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,org_id), FOREIGN KEY(course_version_id,course_id,org_id) REFERENCES course_versions(id,course_id,org_id),
  CHECK((kind='course')=(course_version_id IS NOT NULL)), CHECK((course_id IS NULL)=(course_version_id IS NULL))
);
CREATE TABLE commerce_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, student_id UUID NOT NULL, offer_id UUID NOT NULL,
  client_key UUID NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','declined','cancelled')),
  amount_cents BIGINT NOT NULL CHECK(amount_cents BETWEEN 0 AND 9007199254740991), credit_amount INTEGER NOT NULL CHECK(credit_amount BETWEEN 0 AND 1000000),
  course_id UUID, course_version_id UUID, snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ,
  UNIQUE(id,org_id), UNIQUE(id,org_id,student_id), UNIQUE(org_id,student_id,client_key),
  FOREIGN KEY(student_id,org_id) REFERENCES users(id,org_id), FOREIGN KEY(offer_id,org_id) REFERENCES commerce_offers(id,org_id),
  FOREIGN KEY(course_version_id,course_id,org_id) REFERENCES course_versions(id,course_id,org_id),
  CHECK((course_id IS NULL)=(course_version_id IS NULL)), CHECK((status='pending')=(completed_at IS NULL))
);
CREATE UNIQUE INDEX commerce_pending_course ON commerce_orders(org_id,student_id,course_id) WHERE status='pending' AND course_id IS NOT NULL;
CREATE TABLE commerce_payment_events (
  org_id UUID NOT NULL REFERENCES orgs(id), event_id UUID NOT NULL, order_id UUID NOT NULL,
  requested_status TEXT NOT NULL CHECK(requested_status IN ('pending','approved','declined','cancelled')),
  fingerprint TEXT NOT NULL, applied BOOLEAN NOT NULL, result_status TEXT NOT NULL CHECK(result_status IN ('pending','paid','declined','cancelled')),
  actor_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,event_id), FOREIGN KEY(order_id,org_id) REFERENCES commerce_orders(id,org_id)
);
CREATE TABLE commerce_entitlements (
  order_id UUID PRIMARY KEY, org_id UUID NOT NULL, student_id UUID NOT NULL,
  credit_entry_id UUID UNIQUE, course_enrollment_id UUID UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(order_id,org_id,student_id) REFERENCES commerce_orders(id,org_id,student_id),
  FOREIGN KEY(credit_entry_id,org_id,student_id) REFERENCES wallet_entries(id,org_id,user_id),
  FOREIGN KEY(course_enrollment_id,org_id,student_id) REFERENCES course_enrollments(id,org_id,student_id)
);

CREATE TABLE billing_contract_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id), effective_from DATE NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,effective_from,revision), UNIQUE(id,org_id), CHECK(extract(day FROM effective_from)=1)
);
CREATE TABLE billing_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id), consumption_month DATE NOT NULL,
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'), total_cents BIGINT NOT NULL CHECK(total_cents BETWEEN -9007199254740991 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','settled')), closed_by UUID NOT NULL REFERENCES users(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), settled_at TIMESTAMPTZ,
  UNIQUE(org_id,consumption_month), UNIQUE(id,org_id), CHECK(extract(day FROM consumption_month)=1), CHECK((state='settled')=(settled_at IS NOT NULL))
);
CREATE TABLE billing_usage_allocations (
  org_id UUID NOT NULL, invoice_id UUID NOT NULL, consumption_entry_id UUID PRIMARY KEY,
  credits INTEGER NOT NULL CHECK(credits>0), amount_cents BIGINT NOT NULL CHECK(amount_cents BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY(invoice_id,org_id) REFERENCES billing_invoices(id,org_id), FOREIGN KEY(consumption_entry_id,org_id) REFERENCES wallet_entries(id,org_id)
);
CREATE TABLE billing_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES orgs(id), source_invoice_id UUID NOT NULL,
  client_key UUID, fingerprint TEXT, refund_entry_id UUID UNIQUE,
  amount_cents BIGINT NOT NULL CHECK(amount_cents BETWEEN -9007199254740991 AND 9007199254740991 AND amount_cents<>0),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000), created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), applied_invoice_id UUID,
  UNIQUE(org_id,client_key), FOREIGN KEY(source_invoice_id,org_id) REFERENCES billing_invoices(id,org_id),
  FOREIGN KEY(applied_invoice_id,org_id) REFERENCES billing_invoices(id,org_id), FOREIGN KEY(refund_entry_id,org_id) REFERENCES wallet_entries(id,org_id),
  CHECK((client_key IS NOT NULL AND fingerprint IS NOT NULL AND created_by IS NOT NULL AND refund_entry_id IS NULL)
    OR (client_key IS NULL AND fingerprint IS NULL AND refund_entry_id IS NOT NULL))
);
CREATE TABLE billing_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, invoice_id UUID NOT NULL UNIQUE, event_id UUID NOT NULL,
  amount_cents BIGINT NOT NULL, actor_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,event_id), FOREIGN KEY(invoice_id,org_id) REFERENCES billing_invoices(id,org_id)
);

CREATE FUNCTION commerce_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Commerce record is append-only'; END;
$$;
CREATE TRIGGER commerce_events_append_only BEFORE UPDATE OR DELETE ON commerce_payment_events FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER commerce_entitlements_append_only BEFORE UPDATE OR DELETE ON commerce_entitlements FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER billing_contracts_append_only BEFORE UPDATE OR DELETE ON billing_contract_versions FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER billing_allocations_append_only BEFORE UPDATE OR DELETE ON billing_usage_allocations FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER billing_settlements_append_only BEFORE UPDATE OR DELETE ON billing_settlements FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER billing_school_history_append_only BEFORE UPDATE OR DELETE ON billing_school_history FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER billing_student_history_append_only BEFORE UPDATE OR DELETE ON billing_student_history FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE FUNCTION commerce_order_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Order deletion is prohibited'; END IF;
  IF (NEW.org_id,NEW.student_id,NEW.offer_id,NEW.client_key,NEW.fingerprint,NEW.amount_cents,NEW.credit_amount,NEW.course_id,NEW.course_version_id,NEW.snapshot,NEW.created_at)
    IS DISTINCT FROM (OLD.org_id,OLD.student_id,OLD.offer_id,OLD.client_key,OLD.fingerprint,OLD.amount_cents,OLD.credit_amount,OLD.course_id,OLD.course_version_id,OLD.snapshot,OLD.created_at)
    THEN RAISE EXCEPTION 'Order snapshot is immutable'; END IF; RETURN NEW;
END;
$$;
CREATE TRIGGER commerce_order_snapshot BEFORE UPDATE OR DELETE ON commerce_orders FOR EACH ROW EXECUTE FUNCTION commerce_order_snapshot_immutable();
CREATE FUNCTION billing_invoice_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Invoice deletion is prohibited'; END IF;
  IF (NEW.org_id,NEW.consumption_month,NEW.snapshot,NEW.total_cents,NEW.closed_by,NEW.closed_at)
    IS DISTINCT FROM (OLD.org_id,OLD.consumption_month,OLD.snapshot,OLD.total_cents,OLD.closed_by,OLD.closed_at)
    THEN RAISE EXCEPTION 'Invoice snapshot is immutable'; END IF; RETURN NEW;
END;
$$;
CREATE TRIGGER billing_invoice_snapshot BEFORE UPDATE OR DELETE ON billing_invoices FOR EACH ROW EXECUTE FUNCTION billing_invoice_snapshot_immutable();
CREATE FUNCTION billing_adjustment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Adjustment deletion is prohibited'; END IF;
  IF OLD.applied_invoice_id IS NOT NULL OR (NEW.org_id,NEW.source_invoice_id,NEW.client_key,NEW.fingerprint,NEW.refund_entry_id,NEW.amount_cents,NEW.reason,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.org_id,OLD.source_invoice_id,OLD.client_key,OLD.fingerprint,OLD.refund_entry_id,OLD.amount_cents,OLD.reason,OLD.created_by,OLD.created_at)
    THEN RAISE EXCEPTION 'Adjustment is immutable'; END IF; RETURN NEW;
END;
$$;
CREATE TRIGGER billing_adjustment_snapshot BEFORE UPDATE OR DELETE ON billing_adjustments FOR EACH ROW EXECUTE FUNCTION billing_adjustment_immutable();
