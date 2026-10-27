-- Owner decisions 2026-10-27:
-- * A worker's CLI (its provider class) is chosen when it is registered and
--   recorded as its class; its name no longer carries it. The five worker
--   tables accept any lower-case name of 1-40 letters, digits and hyphens,
--   and the name/class CHECK goes. The registry guard still refuses a class
--   change (AMUX_WORKER_REGISTRY_CLASS_CHANGED), so a name keeps its class.
--   Every name the old grammar allowed is allowed by the new one; the
--   engineering adapter's runner (`engineering-runner`, version 34) is still
--   refused, now by name rather than by its shape.
-- * Each CLI's own model names (Cursor, Copilot and the others do not use the
--   model providers' names) are kept in AmuxCliModel, which the AMUX host
--   refreshes from the CLI itself. The owner links a name to the Admin ›
--   Models entry that prices it in AmuxCliModelLinkEvent, append-only, each
--   link with its audit row. A name with no link prices as before: the Admin
--   › Models entry whose id or API model is that exact name.
--
-- Rollback: drop the two new tables and their guard function, then restore
-- the five previous name CHECKs and the name/class CHECK (only after any
-- worker whose name the old grammar refuses has been retired and removed).
BEGIN;

ALTER TABLE "AmuxWorkerRegistryEvent"
  DROP CONSTRAINT "AmuxWorkerRegistryEvent_name_class_check",
  DROP CONSTRAINT "AmuxWorkerRegistryEvent_worker_name_check",
  ADD CONSTRAINT "AmuxWorkerRegistryEvent_worker_name_check"
      CHECK ("workerName" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' AND "workerName" <> 'engineering-runner');

ALTER TABLE "AmuxWorkerObservation"
  DROP CONSTRAINT "AmuxWorkerObservation_worker_name_check",
  ADD CONSTRAINT "AmuxWorkerObservation_worker_name_check"
      CHECK ("workerName" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' AND "workerName" <> 'engineering-runner');

ALTER TABLE "AmuxWorkerTrialEvidence"
  DROP CONSTRAINT "AmuxWorkerTrialEvidence_worker_name_check",
  ADD CONSTRAINT "AmuxWorkerTrialEvidence_worker_name_check"
      CHECK ("workerName" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' AND "workerName" <> 'engineering-runner');

ALTER TABLE "AmuxWorkerLatchEvent"
  DROP CONSTRAINT "AmuxWorkerLatchEvent_worker_name_check",
  ADD CONSTRAINT "AmuxWorkerLatchEvent_worker_name_check"
      CHECK ("workerName" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' AND "workerName" <> 'engineering-runner');

ALTER TABLE "AmuxWorkerCapabilityEvent"
  DROP CONSTRAINT "AmuxWorkerCapabilityEvent_worker_name_check",
  ADD CONSTRAINT "AmuxWorkerCapabilityEvent_worker_name_check"
      CHECK ("workerName" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' AND "workerName" <> 'engineering-runner');

-- What each CLI lists, as the host last read it. A system observation: it
-- prices nothing by itself and is refreshed in place.
CREATE TABLE "AmuxCliModel" (
    "id" TEXT NOT NULL,
    "cli" TEXT NOT NULL,
    "cliModel" TEXT NOT NULL,
    "displayName" TEXT,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxCliModel_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxCliModel_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxCliModel_cli_check"
      CHECK ("cli" IN ('claude', 'codex', 'cursor', 'copilot')),
    CONSTRAINT "AmuxCliModel_cli_model_check"
      CHECK ("cliModel" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'),
    CONSTRAINT "AmuxCliModel_display_name_check"
      CHECK ("displayName" IS NULL OR pg_catalog.length("displayName") BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "AmuxCliModel_cli_cliModel_key"
  ON "AmuxCliModel"("cli", "cliModel");

-- The owner's links, newest per name wins. A NULL price model is a link to
-- nothing: that name is held, never priced from an exact match.
CREATE TABLE "AmuxCliModelLinkEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "cli" TEXT NOT NULL,
    "cliModel" TEXT NOT NULL,
    "pricedModelId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxCliModelLinkEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxCliModelLinkEvent_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxCliModelLinkEvent_cli_check"
      CHECK ("cli" IN ('claude', 'codex', 'cursor', 'copilot')),
    CONSTRAINT "AmuxCliModelLinkEvent_cli_model_check"
      CHECK ("cliModel" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'),
    CONSTRAINT "AmuxCliModelLinkEvent_priced_model_check"
      CHECK ("pricedModelId" IS NULL OR pg_catalog.length("pricedModelId") BETWEEN 1 AND 160),
    CONSTRAINT "AmuxCliModelLinkEvent_actor_user_check" CHECK (pg_catalog.length("actorUserId") > 0)
);

CREATE UNIQUE INDEX "AmuxCliModelLinkEvent_sequence_key"
  ON "AmuxCliModelLinkEvent"("sequence");
CREATE UNIQUE INDEX "AmuxCliModelLinkEvent_auditLogId_key"
  ON "AmuxCliModelLinkEvent"("auditLogId");
CREATE INDEX "AmuxCliModelLinkEvent_cli_cliModel_sequence_idx"
  ON "AmuxCliModelLinkEvent"("cli", "cliModel", "sequence");

ALTER TABLE "AmuxCliModelLinkEvent"
  ADD CONSTRAINT "AmuxCliModelLinkEvent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A link is history: it is never changed or removed, and its time is the
-- database's.
CREATE OR REPLACE FUNCTION "amux_cli_model_link_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_CLI_MODEL_LINK_IMMUTABLE';
    END IF;
    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "amux_cli_model_link_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxCliModelLinkEvent"
  FOR EACH ROW EXECUTE FUNCTION "amux_cli_model_link_event_guard"();

COMMIT;
