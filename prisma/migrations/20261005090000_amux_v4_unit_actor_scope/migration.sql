-- The original dark unit trigger named the legacy AMUX orchestrator for
-- housekeeping. v4 policy assigns this source its own scoped system actor.
-- Keep the trigger's call sites stable, but require that actor at audit time.
-- baseline-check: replace-function-if-body-sha256 "amux_v4_unit_audit_matches(text,text,text,text,text)" "517eb5c11f8deae277f1e2647940aadc649e40d7bac483cec8f9d2c89b738e17"
CREATE OR REPLACE FUNCTION amux_v4_unit_audit_matches(
    audit_id text, decision_id text, actor_id text,
    expected_action text, expected_system_actor text
) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    audit_action text;
    audit_target_type text;
    audit_target_id text;
    audit_actor_id text;
    audit_entry_hash text;
    audit_system_actor text;
    effective_system_actor text := expected_system_actor;
BEGIN
    IF expected_system_actor = 'tomverse-amux-orchestrator' AND
       expected_action IN ('amux.v4.unit.outcome_unknown',
                           'amux.v4.unit.invalidate', 'amux.v4.unit.expire') THEN
        effective_system_actor := 'amux-v4-intake';
    END IF;
    SELECT a."action", a."targetType", a."targetId", a."actorUserId",
           a."entryHash", a."metadata"->>'systemActor'
      INTO audit_action, audit_target_type, audit_target_id, audit_actor_id,
           audit_entry_hash, audit_system_actor
      FROM public."AdminAuditLog" a WHERE a."id" = audit_id FOR SHARE;
    RETURN audit_action = expected_action AND
           audit_target_type = 'AmuxIdeaUnitDecision' AND
           audit_target_id = decision_id AND
           audit_entry_hash ~ '^[a-f0-9]{64}$' AND
           ((effective_system_actor IS NULL AND audit_actor_id = actor_id AND
             audit_system_actor IS NULL) OR
            (effective_system_actor IS NOT NULL AND audit_actor_id IS NULL AND
             audit_system_actor = effective_system_actor));
END;
$$;
