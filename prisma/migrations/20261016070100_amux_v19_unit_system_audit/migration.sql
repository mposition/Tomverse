-- Intake v19 item 5: allow the scoped registrar to prepare and consume v11
-- decisions while preserving human ownership and same-transaction evidence.
-- baseline-check: replace-function-if-body-sha256 "amux_v4_unit_audit_matches(text,text,text,text,text)" "60cf022509721344893e252018fd4c249fc5a9d0da0b81a8229b5785fe2f560c"
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
    audit_actor_scope text;
    audit_registration_authority text;
    audit_same_transaction boolean;
    effective_system_actor text := expected_system_actor;
BEGIN
    IF expected_system_actor = 'tomverse-amux-orchestrator' AND
       expected_action IN ('amux.v4.unit.outcome_unknown',
                           'amux.v4.unit.invalidate', 'amux.v4.unit.expire') THEN
        effective_system_actor := 'amux-v4-intake';
    END IF;
    SELECT a."action", a."targetType", a."targetId", a."actorUserId",
           a."entryHash", a."metadata"->>'systemActor',
           a."metadata"->>'actorScope',
           a."metadata"->>'registrationAuthority',
           a.xmin = pg_current_xact_id()::xid
      INTO audit_action, audit_target_type, audit_target_id, audit_actor_id,
           audit_entry_hash, audit_system_actor, audit_actor_scope,
           audit_registration_authority, audit_same_transaction
      FROM public."AdminAuditLog" a WHERE a."id" = audit_id FOR SHARE;
    IF expected_system_actor IS NULL AND
       expected_action IN ('amux.v4.unit.prepare', 'amux.v4.unit.consume') AND
       audit_system_actor = 'amux-v4-intake' THEN
        effective_system_actor := 'amux-v4-intake';
    END IF;
    RETURN audit_action = expected_action AND
           audit_target_type = 'AmuxIdeaUnitDecision' AND
           audit_target_id = decision_id AND
           audit_entry_hash ~ '^[a-f0-9]{64}$' AND
           ((effective_system_actor IS NULL AND audit_actor_id = actor_id AND
             audit_system_actor IS NULL) OR
            (effective_system_actor IS NOT NULL AND audit_actor_id IS NULL AND
             audit_system_actor = effective_system_actor AND
             (expected_action NOT IN ('amux.v4.unit.prepare', 'amux.v4.unit.consume') OR
              (audit_same_transaction IS TRUE AND
               audit_actor_scope = 'system-unit-registration-v1' AND
               audit_registration_authority = 'system'))));
END;
$$;
