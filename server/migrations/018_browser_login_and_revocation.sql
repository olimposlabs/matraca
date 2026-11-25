ALTER TABLE auth_tokens ADD COLUMN intent_hash TEXT CHECK(intent_hash ~ '^[0-9a-f]{64}$');
UPDATE auth_tokens SET used_at=clock_timestamp() WHERE used_at IS NULL;
UPDATE sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL;
DELETE FROM auth_rate_limits;
CREATE INDEX auth_rate_window_expiration ON auth_rate_limits(window_started_at);

CREATE FUNCTION revoke_user_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status='suspended' AND OLD.status IS DISTINCT FROM NEW.status)
     OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL) THEN
    UPDATE sessions SET revoked_at=clock_timestamp()
      WHERE org_id=NEW.org_id AND user_id=NEW.id AND revoked_at IS NULL;
    UPDATE auth_tokens SET used_at=clock_timestamp()
      WHERE org_id=NEW.org_id AND user_id=NEW.id AND used_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_access_revoked AFTER UPDATE OF status,archived_at ON users
  FOR EACH ROW EXECUTE FUNCTION revoke_user_access();

CREATE FUNCTION revoke_organization_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='suspended' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE sessions SET revoked_at=clock_timestamp() WHERE org_id=NEW.id AND revoked_at IS NULL;
    UPDATE auth_tokens SET used_at=clock_timestamp() WHERE org_id=NEW.id AND used_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organization_access_revoked AFTER UPDATE OF status ON orgs
  FOR EACH ROW EXECUTE FUNCTION revoke_organization_access();
