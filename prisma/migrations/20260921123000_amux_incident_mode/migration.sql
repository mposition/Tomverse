-- AMUX incident mode is a deployment-wide admission brake.
--
-- Current state lives in AppSetting so every admission path can read one
-- authoritative row. Transitions are append-only evidence. The shared
-- advisory transaction lock in lib/amux/incident.ts serializes a declaration
-- or clear with claim and execution start. Durable deliveries already admitted
-- before the freeze continue draining and can heartbeat, settle, or recover.

CREATE TABLE "AmuxIncidentTransition" (
    "id" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "approvalId" TEXT,
    "authorizationAuditLogId" TEXT,
    "changeAuditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxIncidentTransition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIncidentTransition_from_state_check"
        CHECK ("fromState" IN ('normal', 'frozen')),
    CONSTRAINT "AmuxIncidentTransition_to_state_check"
        CHECK ("toState" IN ('normal', 'frozen')),
    CONSTRAINT "AmuxIncidentTransition_reason_check"
        CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
    CONSTRAINT "AmuxIncidentTransition_ticket_check"
        CHECK (length(btrim("ticket")) BETWEEN 1 AND 120),
    CONSTRAINT "AmuxIncidentTransition_clear_authorization_check"
        CHECK (
          "toState" = 'frozen'
          OR "authorizationAuditLogId" IS NOT NULL
        )
);

CREATE UNIQUE INDEX "AmuxIncidentTransition_changeAuditLogId_key"
    ON "AmuxIncidentTransition"("changeAuditLogId");
CREATE INDEX "AmuxIncidentTransition_createdAt_idx"
    ON "AmuxIncidentTransition"("createdAt");
CREATE INDEX "AmuxIncidentTransition_toState_createdAt_idx"
    ON "AmuxIncidentTransition"("toState", "createdAt");

CREATE FUNCTION amux_incident_transition_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'AmuxIncidentTransition is append-only';
END;
$$;

CREATE TRIGGER "AmuxIncidentTransition_reject_update"
BEFORE UPDATE ON "AmuxIncidentTransition"
FOR EACH ROW
EXECUTE FUNCTION amux_incident_transition_append_only_guard();

CREATE TRIGGER "AmuxIncidentTransition_reject_delete"
BEFORE DELETE ON "AmuxIncidentTransition"
FOR EACH ROW
EXECUTE FUNCTION amux_incident_transition_append_only_guard();

-- The application treats a missing or malformed row as frozen. Seed an
-- explicit normal baseline so rollout itself does not stop admission.
INSERT INTO "AppSetting" ("key", "value", "createdAt", "updatedAt")
VALUES (
  'amux.incidentMode',
  json_build_object(
    'version', 1,
    'state', 'normal',
    'transition_id', NULL,
    'changed_at', to_char(
      CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'reason', 'Initial incident-mode rollout state.',
    'ticket', 'migration:20260921123000'
  )::text,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
