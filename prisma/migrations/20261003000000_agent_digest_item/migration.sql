-- The shared agent digest table (AgentDigestItem): one table for every agent
-- team's daily results, told apart by "agentKey". The contract is shared by
-- five agent designs; the first user is the QA-release agent
-- (docs/policy/qa-release-agent.md). Additive only: one table, three functions
-- and three triggers. Nothing here writes a row.
--
-- What the database enforces, rather than the application:
--
-- * "agentKey" is a closed list and each agent's "kind" values are a closed
--   list of their own. Adding an agent or a kind is a reviewed migration.
-- * The idempotency key starts with "<agentKey>:" and carries something after
--   it -- two CHECKs written as string comparison, not LIKE, so a future
--   "agentKey" containing % or _ cannot weaken them. One agent's secret can
--   therefore never claim another agent's key.
-- * A row is born with its body: an insert with no payload, with a deletion
--   time, or with a non-positive size is refused, and the pair CHECK admits
--   only "body present, never deleted" or "body gone, deletion recorded".
-- * "createdAt" and "retentionUntil" are set on insert from the database
--   clock and the agent's body-retention period; nothing the writer sends can
--   move them.
-- * The only update is the body expiry: after "retentionUntil", "payload" goes
--   to NULL and "bodyDeletedAt" to the database clock, together. Every other
--   column is immutable and every other update is refused.
-- * The only delete is of a row whose body is already gone and whose
--   "createdAt" is more than 365 days old.
--
-- Size and hash: "sizeBytes" and "payloadSha256" describe the canonical bytes
-- (lib/agentDigestCanonicalJson.ts) computed once by the writer before the
-- insert; the database checks their range and shape only.
--
-- `prisma db push` creates the table and none of the functions or triggers.
-- The DB integration suite runs on the migration history, which is where the
-- triggers are tested.
--
-- The trigger functions pin search_path to pg_catalog, pg_temp and call no
-- function of this schema, so no object a session puts first on its path can
-- stand in for them -- the retention period in particular is a CASE in the
-- first trigger function below, not a lookup by name.
--
-- Rollback: drop the three triggers, the three functions, then the table.
-- That discards every agent's stored digests.

BEGIN;

CREATE TABLE "AgentDigestItem" (
    "id" UUID NOT NULL,
    "agentKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB,
    "payloadSha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retentionUntil" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bodyDeletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AgentDigestItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentDigestItem_agent_key_check"
      CHECK ("agentKey" IN ('qa-release')),
    CONSTRAINT "AgentDigestItem_kind_check"
      CHECK (("agentKey" = 'qa-release' AND "kind" IN ('daily_digest'))),
    CONSTRAINT "AgentDigestItem_schema_version_check"
      CHECK ("schemaVersion" BETWEEN 1 AND 1000),
    CONSTRAINT "AgentDigestItem_idempotency_prefix_check"
      CHECK (left("idempotencyKey", length("agentKey") + 1) = "agentKey" || ':'),
    CONSTRAINT "AgentDigestItem_idempotency_suffix_check"
      CHECK (length("idempotencyKey") > length("agentKey") + 1),
    CONSTRAINT "AgentDigestItem_idempotency_length_check"
      CHECK (char_length("idempotencyKey") <= 200),
    CONSTRAINT "AgentDigestItem_payload_sha256_check"
      CHECK ("payloadSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AgentDigestItem_size_bytes_check"
      CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 16384),
    CONSTRAINT "AgentDigestItem_body_state_check"
      CHECK (("payload" IS NOT NULL AND "bodyDeletedAt" IS NULL)
          OR ("payload" IS NULL AND "bodyDeletedAt" IS NOT NULL)),
    CONSTRAINT "AgentDigestItem_retention_check"
      CHECK ("retentionUntil" > "createdAt")
);

CREATE UNIQUE INDEX "AgentDigestItem_agentKey_idempotencyKey_key"
  ON "AgentDigestItem"("agentKey", "idempotencyKey");

CREATE INDEX "AgentDigestItem_agentKey_createdAt_idx"
  ON "AgentDigestItem"("agentKey", "createdAt");

CREATE INDEX "AgentDigestItem_retentionUntil_idx"
  ON "AgentDigestItem"("retentionUntil");

CREATE FUNCTION agent_digest_item_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  -- Each agent's body-retention period. An agent without one cannot insert.
  retention INTERVAL := CASE NEW."agentKey"
    WHEN 'qa-release' THEN INTERVAL '90 days'
  END;
BEGIN
  IF NEW."payload" IS NULL OR NEW."bodyDeletedAt" IS NOT NULL OR NEW."sizeBytes" <= 0 THEN
    RAISE EXCEPTION 'AgentDigestItem rows are inserted with their body'
      USING ERRCODE = 'check_violation';
  END IF;
  IF retention IS NULL THEN
    RAISE EXCEPTION 'AgentDigestItem has no body retention for this agent'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."createdAt" := clock_timestamp();
  NEW."retentionUntil" := NEW."createdAt" + retention;
  RETURN NEW;
END;
$$;

CREATE FUNCTION agent_digest_item_before_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."agentKey" IS DISTINCT FROM OLD."agentKey"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."payloadSha256" IS DISTINCT FROM OLD."payloadSha256"
     OR NEW."sizeBytes" IS DISTINCT FROM OLD."sizeBytes"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."retentionUntil" IS DISTINCT FROM OLD."retentionUntil" THEN
    RAISE EXCEPTION 'AgentDigestItem identity, hash, size and clock columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."payload" IS NOT NULL
     AND NEW."payload" IS NULL
     AND OLD."retentionUntil" < clock_timestamp() THEN
    NEW."bodyDeletedAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AgentDigestItem allows only the expiry of a body past its retention'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE FUNCTION agent_digest_item_before_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."bodyDeletedAt" IS NOT NULL
     AND OLD."createdAt" < clock_timestamp() - INTERVAL '365 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AgentDigestItem rows are deleted only after body expiry and 365 days'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "AgentDigestItem_before_insert"
  BEFORE INSERT ON "AgentDigestItem"
  FOR EACH ROW EXECUTE FUNCTION agent_digest_item_before_insert();

CREATE TRIGGER "AgentDigestItem_before_update"
  BEFORE UPDATE ON "AgentDigestItem"
  FOR EACH ROW EXECUTE FUNCTION agent_digest_item_before_update();

CREATE TRIGGER "AgentDigestItem_before_delete"
  BEFORE DELETE ON "AgentDigestItem"
  FOR EACH ROW EXECUTE FUNCTION agent_digest_item_before_delete();

COMMIT;
