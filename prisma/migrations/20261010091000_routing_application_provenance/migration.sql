-- Historical rows remain unattributed. No update/backfill is permitted.
ALTER TABLE "RoutingRun"
  ADD COLUMN "applicationCommitSha" TEXT,
  ADD COLUMN "applicationDeploymentId" TEXT,
  ADD COLUMN "applicationEnvironment" TEXT,
  ADD CONSTRAINT "RoutingRun_application_identity_complete_check" CHECK (
    ("applicationCommitSha" IS NULL AND "applicationDeploymentId" IS NULL AND "applicationEnvironment" IS NULL)
    OR ("applicationCommitSha" IS NOT NULL AND "applicationDeploymentId" IS NOT NULL AND "applicationEnvironment" IS NOT NULL
      AND "applicationCommitSha" ~ '^[a-f0-9]{40}$'
      AND "applicationDeploymentId" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND "applicationEnvironment" IN ('development', 'dev', 'staging', 'production', 'test'))
  );

CREATE FUNCTION routing_application_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."applicationCommitSha", NEW."applicationDeploymentId", NEW."applicationEnvironment")
    IS DISTINCT FROM ROW(OLD."applicationCommitSha", OLD."applicationDeploymentId", OLD."applicationEnvironment") THEN
    RAISE EXCEPTION 'RoutingRun application identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RoutingRun_application_identity_immutable"
BEFORE UPDATE ON "RoutingRun" FOR EACH ROW
EXECUTE FUNCTION routing_application_identity_immutable();
